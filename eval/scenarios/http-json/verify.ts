import type { VerifierContext, VerifierResult } from "../../src/scenario";

/**
 * Exact-match verifier for the http-json A/B benchmark.
 *
 * Ground truth is fetched LIVE from httpbin at verify time so the test self-
 * updates if httpbin ever rewords the title. httpbin can be flaky; on network
 * failure we fall back to the value baked into scenario.json.expected_outcome
 * and note that in details so the run is still scorable.
 *
 * Score: binary {0,1}. Pass iff trim(finalText) === expectedTitle. We also
 * record `containsTitle` in evidence so the benchmark can tell apart
 *   - exact match (improved condition's win), vs
 *   - contains-but-wrapped (e.g. the agent typed "The title is 'X'.").
 */
export async function verify(ctx: VerifierContext): Promise<VerifierResult> {
  const exp = (ctx.expected ?? {}) as {
    url?: string;
    json_path?: string;
    fallback_title?: string;
  };
  const url = exp.url ?? "https://httpbin.org/json";
  const path = exp.json_path ?? "slideshow.title";
  const fallback = exp.fallback_title ?? "Sample Slide Show";

  const { value: expectedTitle, source: groundSource, error: fetchErr } =
    await resolveTitle(url, path, fallback);

  const out = (ctx.trace.finalText ?? "").trim();
  const exact = out === expectedTitle;
  const contains =
    !!expectedTitle && out.toLowerCase().includes(expectedTitle.toLowerCase());

  const details = exact
    ? `exact match for "${expectedTitle}" (ground truth via ${groundSource})`
    : `expected "${expectedTitle}" (via ${groundSource}); got "${truncate(out, 120)}"${fetchErr ? ` — live fetch failed: ${fetchErr}` : ""}`;

  return {
    pass: exact,
    score: exact ? 1 : 0,
    details,
    evidence: {
      expectedTitle,
      groundTruthSource: groundSource,
      output: out,
      exactMatch: exact,
      containsTitle: contains,
      ...(fetchErr ? { liveFetchError: fetchErr } : {}),
    },
  };
}

/** Live httpbin lookup with timeout + two retries; falls back to scenario value. */
async function resolveTitle(
  url: string,
  jsonPath: string,
  fallback: string,
): Promise<{ value: string; source: "live" | "fallback"; error?: string }> {
  let lastErr: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const data: any = await res.json();
      let cur: any = data;
      for (const seg of jsonPath.split(".")) {
        if (cur == null) break;
        cur = cur[seg];
      }
      if (typeof cur !== "string")
        throw new Error(`json_path ${jsonPath} not a string: ${JSON.stringify(cur).slice(0, 80)}`);
      return { value: cur, source: "live" };
    } catch (e: any) {
      lastErr = String(e?.message ?? e);
    } finally {
      clearTimeout(to);
    }
    // small backoff between retries
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  return { value: fallback, source: "fallback", error: lastErr };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
