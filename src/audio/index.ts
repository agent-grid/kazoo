// Public surface of the audio module. Keep callers importing from here
// rather than reaching into mic.ts / speaker.ts directly — that way the
// future swap from subprocess → native binding stays a single-file change.

export {
  BYTES_PER_SAMPLE,
  base64ToInt16,
  CHANNELS,
  durationMs,
  int16ToBase64,
  SAMPLE_RATE_HZ,
} from './format.ts'
export { createMic, type MicConfig, type MicStream } from './mic.ts'
export { createSpeaker, type Speaker, type SpeakerConfig } from './speaker.ts'
