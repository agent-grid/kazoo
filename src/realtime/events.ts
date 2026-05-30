// Internal event surface emitted by RealtimeSession.
//
// Replaces the upstream `CallEvent` IPC type — Kazoo is single-process, so we
// don't need the renderer/main shape. The discriminator stays `type` so the
// switch ergonomics from the lifted client carry over without churn.

export type RealtimeSessionState = 'idle' | 'connecting' | 'active' | 'closing' | 'ended' | 'error'

/** State transition. `ended` carries close-code metadata. */
export type StateEvent =
  | { type: 'state'; state: Exclude<RealtimeSessionState, 'ended'> }
  | {
      type: 'state'
      state: 'ended'
      code: number
      reason: string
      clientInitiated: boolean
    }

/** A server-reported error that isn't a benign cancel race. */
export type ErrorEvent = {
  type: 'error'
  message: string
  code?: string
}

/** Server-VAD detected the start/stop of user speech. The orchestrator uses
 *  `speech-started` to flush the speaker queue for barge-in. */
export type SpeechStartedEvent = { type: 'speech-started' }
export type SpeechStoppedEvent = { type: 'speech-stopped' }

/** Transcript chunk — user side is always final; assistant side streams. */
export type CaptionEvent = {
  type: 'caption'
  role: 'user' | 'assistant'
  text: string
  final: boolean
}

/** A frame of base64 PCM16 @ 24 kHz mono from the model. Hand straight to the
 *  speaker. The audio module owns decoding + queueing. */
export type AudioChunkEvent = {
  type: 'audio-chunk'
  audio: string
}

/** End-of-audio marker for the current response turn. */
export type AudioDoneEvent = { type: 'audio-done' }

/** The model finished a (non-wrap-up) response. */
export type ResponseDoneEvent = {
  type: 'response-done'
  status?: string
}

/** Text-only wrap-up turn (see `requestWrapUp` in session.ts) returned its
 *  full text. Used by the memory module on hangup. */
export type WrapUpTextEvent = {
  type: 'wrap-up-text'
  text: string
}

export type RealtimeEvent =
  | StateEvent
  | ErrorEvent
  | SpeechStartedEvent
  | SpeechStoppedEvent
  | CaptionEvent
  | AudioChunkEvent
  | AudioDoneEvent
  | ResponseDoneEvent
  | WrapUpTextEvent

export type RealtimeEventHandler = (ev: RealtimeEvent) => void
