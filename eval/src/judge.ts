/**
 * LLM-as-judge verifier (see initial-spec.md "Verification" -> llm_judge).
 *
 * Self-contained: takes a VerifierContext, calls a pinned judge model with the
 * scenario's prompts + the agent's finalText + the rubric, parses a graded
 * {score, pass, reasoning} JSON envelope, and returns a VerifierResult whose
 * score is in [0,1] (vs the binary {0,1} a script verifier returns).
 *
 * Reproducibility: judge model, temperature, threshold, and per-sample raw
 * scores are recorded in the returned evidence so a run can be re-judged or
 * audited later. temperature is PINNED to 0; n-sample majority (opts.samples)
 * exists to reduce variance for marginal cases (default 1 to keep cost low).
 *
 * Defensive: any API/parse failure returns a failing VerifierResult rather
 * than throwing, so a flaky judge can't crash an eval run.
 */
import type { VerifierContext, VerifierResult } from "./scenario";

const CHAT_ENDPOINT = "https://api.openai.com/v1/chat/completions";

/** Pinned judge default. gpt-4o is widely available + cheap enough for grading;
 *  override with VOICE_EVAL_JUDGE_MODEL (e.g. gpt-4o-mini for cheaper, gpt-4.1
 *  for stronger). Whatever runs is recorded in evidence.judgeModel. */
const DEFAULT_JUDGE_MODEL = "gpt-4o";

export interface JudgeOptions {
  /** Pass threshold in [0,1]. Default 0.7. */
  threshold?: number;
  /** N-sample majority (averaged score, majority pass). Default 1. */
  samples?: number;
  /** Override the judge model id. */
  model?: string;
}

interface JudgeSample {
  score: number;
  pass: boolean;
  reasoning: string;
}

/** The grading rubric the judge reads. Pulled from the scenario's
 *  expected_outcome.rubric if present, else falls back to a generic one. */
function rubricFor(expected: unknown): string {
  if (expected && typeof expected === "object") {
    const r = (expected as Record<string, unknown>).rubric;
    if (typeof r === "string" && r.trim()) return r.trim();
  }
  if (typeof expected === "string" && expected.trim()) return expected.trim();
  return "The response should correctly and completely address the user's request.";
}

/** Prompts pinned per spec: temperature 0, strict JSON envelope, no chain-of-thought leak. */
function buildMessages(ctx: VerifierContext, rubric: string) {
  // The trace's finalText is the thing being graded. The rubric is the
  // authoritative spec of correctness; we deliberately do not re-send the
  // original user_prompt — keeping the judge focused on the rubric prevents
  // it from inventing its own criteria.
  const finalText = ctx.trace.finalText || "(empty)";

  const system =
    "You are a strict, impartial evaluator. You grade an AI assistant's answer " +
    "against a rubric and return JSON only. Do not include any prose outside the JSON. " +
    "Be conservative: only award a high score if the rubric is clearly satisfied.";

  const user =
    `RUBRIC (authoritative):\n${rubric}\n\n` +
    `ASSISTANT RESPONSE TO GRADE:\n${finalText}\n\n` +
    `Return STRICT JSON with this exact shape and no extra keys:\n` +
    `{"score": <number in [0,1]>, "pass": <boolean>, "reasoning": "<one to three sentences>"}\n` +
    `score: 1.0 = fully satisfies the rubric; 0.0 = misses entirely; partial credit allowed.\n` +
    `pass: true iff the response would be acceptable to ship to a user.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Strip ```json fences / leading prose and parse the first JSON object found. */
function parseJudge(raw: string): JudgeSample {
  let s = raw.trim();
  // Strip ``` fences (with or without language tag).
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  // If the model wrapped JSON in prose, find the first {...} block.
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  const obj = JSON.parse(s);
  const score = Number(obj.score);
  if (!Number.isFinite(score)) throw new Error("judge returned non-numeric score");
  return {
    score: Math.max(0, Math.min(1, score)),
    pass: Boolean(obj.pass),
    reasoning: String(obj.reasoning ?? ""),
  };
}

async function callJudgeOnce(
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
): Promise<JudgeSample> {
  // Same fetch + Bearer auth pattern the openai-realtime adapter uses.
  const res = await fetch(CHAT_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0, // PINNED for reproducibility
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`judge HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const j: any = await res.json();
  const content = j?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("judge response missing content");
  return parseJudge(content);
}

export async function judge(
  ctx: VerifierContext,
  opts: JudgeOptions = {},
): Promise<VerifierResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = opts.model || process.env.VOICE_EVAL_JUDGE_MODEL || DEFAULT_JUDGE_MODEL;
  const threshold = opts.threshold ?? 0.7;
  const samples = Math.max(1, Math.floor(opts.samples ?? 1));

  if (!apiKey) {
    return {
      pass: false,
      score: 0,
      details: "judge error: OPENAI_API_KEY not set",
      evidence: { judgeModel: model, temperature: 0, threshold, samples },
    };
  }

  const rubric = rubricFor(ctx.expected);
  const messages = buildMessages(ctx, rubric);

  const results: JudgeSample[] = [];
  const errors: string[] = [];
  for (let i = 0; i < samples; i++) {
    try {
      results.push(await callJudgeOnce(apiKey, model, messages));
    } catch (e: any) {
      errors.push(String(e?.message ?? e));
    }
  }

  if (!results.length) {
    return {
      pass: false,
      score: 0,
      details: `judge error: ${errors[0] ?? "no samples returned"}`,
      evidence: { judgeModel: model, temperature: 0, threshold, samples, errors },
    };
  }

  // Aggregate: averaged score, majority pass (ties -> pass when >= threshold).
  const rawScores = results.map((r) => r.score);
  const avgScore = rawScores.reduce((a, b) => a + b, 0) / rawScores.length;
  const passes = results.filter((r) => r.pass).length;
  const majorityPass = passes * 2 > results.length;
  // Final pass: both majority-pass AND average meets threshold (defensive AND).
  const pass = majorityPass && avgScore >= threshold;

  return {
    pass,
    score: avgScore,
    details:
      `judge=${model} score=${avgScore.toFixed(2)} threshold=${threshold} ` +
      `samples=${samples} pass=${pass}`,
    evidence: {
      judgeModel: model,
      temperature: 0,
      threshold,
      samples,
      rawScores,
      reasoning: results.map((r) => r.reasoning),
      rubric,
      errors: errors.length ? errors : undefined,
    },
  };
}
