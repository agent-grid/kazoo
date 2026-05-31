/**
 * Synthesize a scenario's input.wav from text using OpenAI TTS. Used as a
 * bootstrap so speech scenarios are runnable before someone records a real
 * human voice fixture. The runner PREFERS an existing input.wav; this script
 * is what fills the gap when one is missing.
 *
 * Usage:
 *   bun run scripts/gen-input.ts scenarios/speech-smoke
 *
 * It reads `input_text` (preferred) or falls back to `user_prompt` from
 * scenario.json and writes scenarios/<id>/input.wav (PCM16 mono @ 24kHz).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { synthesizePcm16 } from "../src/tts";
import { pcm16ToWav } from "../src/util/wav";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: bun run scripts/gen-input.ts <scenarioDir>");
  process.exit(1);
}
const sFile = resolve(dir, "scenario.json");
if (!existsSync(sFile)) {
  console.error(`no scenario.json in ${dir}`);
  process.exit(1);
}
const scenario = JSON.parse(readFileSync(sFile, "utf8"));
const text: string = scenario.input_text ?? scenario.user_prompt;
if (!text) {
  console.error(`scenario has no input_text or user_prompt to synthesize`);
  process.exit(1);
}
const out = resolve(dir, "input.wav");
console.log(`tts → ${out}\n  text: ${text}`);
const pcm = await synthesizePcm16(text);
writeFileSync(out, pcm16ToWav(pcm));
console.log(`  wrote ${pcm.length} pcm bytes (${(pcm.length / (24000 * 2)).toFixed(2)}s)`);
