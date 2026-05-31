/**
 * Reference ASR — a measurement instrument independent of the agent. The
 * harness transcribes the agent's output audio and scores THAT transcript
 * (see initial-spec.md "Speech I/O"). Backend is pluggable; only the OpenAI
 * hosted backend ships today.
 *
 * NOTE on the model: the OpenAI transcriptions API's `whisper-1` is hosted
 * Whisper large-v2, NOT large-v3. The spec calls for large-v3 run locally as
 * the "vendor-neutral" reference; that's a future backend. The interface here
 * stays clean so a local large-v3 backend can drop in behind it.
 */

export interface AsrResult {
  text: string;
  /** The actual model id used (recorded into report.json for reproducibility). */
  model: string;
}

export interface AsrOptions {
  /** Override the model id (default: env VOICE_EVAL_ASR_MODEL or whisper-1). */
  model?: string;
  /** ISO-639-1 hint, e.g. "en". Optional. */
  language?: string;
}

const DEFAULT_MODEL = process.env.VOICE_EVAL_ASR_MODEL || "whisper-1";

/** Transcribe a WAV (PCM16 mono) buffer. */
export async function transcribe(
  wavBytes: Uint8Array,
  opts: AsrOptions = {},
): Promise<AsrResult> {
  return transcribeOpenAI(wavBytes, opts);
}

async function transcribeOpenAI(
  wavBytes: Uint8Array,
  opts: AsrOptions,
): Promise<AsrResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const model = opts.model ?? DEFAULT_MODEL;

  const form = new FormData();
  form.set("model", model);
  if (opts.language) form.set("language", opts.language);
  // Web FormData accepts Blob; wrap the bytes (copy into a fresh ArrayBuffer to
  // satisfy BlobPart typing across the Uint8Array/SharedArrayBuffer union).
  const ab = new ArrayBuffer(wavBytes.byteLength);
  new Uint8Array(ab).set(wavBytes);
  form.set("file", new Blob([ab], { type: "audio/wav" }), "output.wav");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ASR HTTP ${res.status}: ${body.slice(0, 400)}`);
  }
  const j: any = await res.json();
  return { text: String(j.text ?? "").trim(), model };
}
