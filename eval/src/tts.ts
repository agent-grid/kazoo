/**
 * TTS for synthesizing scenario INPUT fixtures (the user's voice). Per the
 * spec, real human recordings are preferred; TTS is the bootstrap fallback so
 * scenarios are runnable end-to-end before recordings exist.
 *
 * Output is raw PCM16 mono @ 24kHz, which matches the Realtime adapter's
 * input audio format — no resampling needed before feeding it back in.
 */

const TTS_ENDPOINT = "https://api.openai.com/v1/audio/speech";

export interface TtsOptions {
  /** OpenAI TTS model. Default tts-1 (cheap, fine for fixtures). */
  model?: string;
  /** Voice name. Default "alloy". */
  voice?: string;
}

/** Synthesize `text` to raw PCM16 mono @ 24kHz bytes. */
export async function synthesizePcm16(
  text: string,
  opts: TtsOptions = {},
): Promise<Uint8Array> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const res = await fetch(TTS_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model ?? process.env.VOICE_EVAL_TTS_MODEL ?? "tts-1",
      voice: opts.voice ?? process.env.VOICE_EVAL_TTS_VOICE ?? "alloy",
      input: text,
      // raw PCM (16-bit signed, mono, 24kHz) — no container, no resample
      response_format: "pcm",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`TTS HTTP ${res.status}: ${body.slice(0, 400)}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf;
}
