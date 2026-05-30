// OpenAI Realtime API client — Kazoo's "ears + mouth".
//
// Adapted from a battle-tested Electron-main-process implementation:
//   - swapped renderer/IPC event shape for the in-process `RealtimeEvent` union
//     (see ./events.ts);
//   - swapped console.warn/error for an injectable logger so Ink can own stdout;
//   - added `injectNarration()` — the AUDIO-modality cousin of `requestWrapUp`,
//     which is how the executor's events get spoken in the agent's voice.
//
// Everything else — the GA wire protocol, session.update payload shape,
// server-event handling, the cancel/race guards — is intentionally unchanged.
//
// Wire protocol (OpenAI Realtime GA, as of 2026-05; the beta protocol with
// `OpenAI-Beta: realtime=v1` was removed 2026-05-07):
//   - WebSocket wss://api.openai.com/v1/realtime?model=<model>
//   - Upgrade header: Authorization: Bearer <key>  (no Beta header in GA)
//   - All messages are JSON with a `type` field.
//   - Audio is base64 PCM16 little-endian, 24 kHz mono.
//
// If the API shape drifts again, the diff lives almost entirely in
// `handleServerEvent` below and the `session.update` payload.

import WebSocket from 'ws'
import type { Logger } from '../lib/logger.ts'
import type { RealtimeEvent, RealtimeEventHandler, RealtimeSessionState } from './events.ts'

const REALTIME_URL_BASE = 'wss://api.openai.com/v1/realtime'

/** OpenAI's GA model alias. `gpt-realtime-mini` is also valid. */
export const DEFAULT_MODEL = 'gpt-realtime'
/** Always GA-available. Other voices may require account verification. */
export const DEFAULT_VOICE = 'alloy'

export type RealtimeSessionArgs = {
  apiKey: string
  model?: string
  voice?: string
  /** Maps to `audio.output.speed` on session.update. Caller is expected to
   *  have already clamped to the API's [0.25, 1.5] window; omit to use the
   *  API default (1.0). */
  speed?: number
  instructions: string
  onEvent: RealtimeEventHandler
  logger: Logger
  /** If true, suppress the opening `response.create` so the agent waits for
   *  the user to speak first. Default false (matches reference behavior). */
  suppressOpeningResponse?: boolean
}

// Server-event payload shape — only the fields we read. Everything else is
// ignored so the protocol can grow new fields without breaking us.
type ServerEvent = {
  type?: string
  delta?: string
  transcript?: string
  text?: string
  message?: string
  error?: { message?: string; code?: string }
  response?: { status?: string }
}

export class RealtimeSession {
  state: RealtimeSessionState = 'idle'

  private readonly apiKey: string
  private readonly model: string
  private readonly speed: number | undefined
  private readonly instructions: string
  private readonly onEvent: RealtimeEventHandler
  private readonly logger: Logger
  private readonly suppressOpeningResponse: boolean

  // Active voice. Starts at the caller's choice; on a voice-not-available
  // error from session.update we fall back to DEFAULT_VOICE once and resend.
  private voice: string
  private voiceFallbackTried = false

  private ws: WebSocket | null = null
  private clientInitiatedClose = false
  // Tracks whether a server response is currently in flight. Flipped true on
  // `response.created`, false on `response.done` / `response.cancelled`. The
  // public `cancelResponse()` no-ops when this is false so we never send a
  // cancel that the server will reject with "no active response found".
  private responseActive = false
  // Wrap-up turn bookkeeping. When `requestWrapUp` is called we kick off a
  // text-only response and accumulate its text chunks here.
  private wrapUpPending = false
  private wrapUpText = ''

  constructor(args: RealtimeSessionArgs) {
    if (!args.apiKey) throw new Error('OpenAI API key required')
    if (typeof args.onEvent !== 'function') throw new Error('onEvent required')
    this.apiKey = args.apiKey
    this.model = args.model || DEFAULT_MODEL
    // `voice` is mutable so the fallback in handleServerEvent can switch
    // it on a voice-not-available error and resend session.update.
    this.voice = args.voice || DEFAULT_VOICE
    this.speed = args.speed
    this.instructions = args.instructions || ''
    this.onEvent = args.onEvent
    this.logger = args.logger
    this.suppressOpeningResponse = args.suppressOpeningResponse ?? false
  }

  /** Open the WS, send session.update, then (unless suppressed) issue
   *  response.create so the agent speaks first. Resolves once the handshake
   *  succeeded; caller can begin streaming mic audio after this resolves. */
  async connect(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`RealtimeSession already started (${this.state})`)
    }
    this.state = 'connecting'
    this.emit({ type: 'state', state: 'connecting' })

    const url = `${REALTIME_URL_BASE}?model=${encodeURIComponent(this.model)}`
    // GA protocol — no `OpenAI-Beta: realtime=v1` header. Including it is
    // forbidden in GA (the beta endpoint was removed 2026-05-07).
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    })
    this.ws = socket

    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        socket.off('error', onError)
        socket.off('unexpected-response', onUnexpectedResponse)
        resolve()
      }
      const onError = (err: Error): void => {
        socket.off('open', onOpen)
        socket.off('unexpected-response', onUnexpectedResponse)
        reject(err)
      }
      const onUnexpectedResponse = (
        _req: unknown,
        res: { statusCode?: number; headers?: Record<string, unknown> },
      ): void => {
        const chunks: Buffer[] = []
        const stream = res as unknown as NodeJS.ReadableStream
        stream.on('data', (c: Buffer) => chunks.push(c))
        stream.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8')
          this.logger.error(
            {
              statusCode: res.statusCode,
              headers: res.headers,
              body: body.slice(0, 1000),
            },
            'realtime: unexpected-response on WS upgrade',
          )
        })
      }
      socket.once('open', onOpen)
      socket.once('error', onError)
      socket.once('unexpected-response', onUnexpectedResponse)
    })

    // Long-lived handlers bind AFTER the handshake so a transient connect
    // error doesn't double-fire as both reject AND a 'state: error' event.
    socket.on('message', (data) => this.handleServerMessage(data))
    socket.on('close', (code, reason) => this.handleClose(code, reason.toString('utf-8')))
    socket.on('error', (err) => this.handleSocketError(err))

    // Configure the session BEFORE streaming mic audio. Server-VAD with
    // conservative thresholds — too sensitive triggers false barge-ins; too
    // loose makes turn-end laggy. 500 ms silence is the documented sweet spot.
    //
    // GA payload shape (restructured from beta):
    //   - `type: 'realtime'` is required on the session object.
    //   - `output_modalities` replaces `modalities`.
    //   - Audio config nests under `audio.input` / `audio.output`.
    //   - `format` is `{ type, rate }` instead of the flat `'pcm16'` string.
    //   - `turn_detection` moved under `audio.input`.
    //   - `voice` moved under `audio.output`.
    //   - Input transcription uses `gpt-4o-mini-transcribe` (GA default).
    //
    // `output_modalities` accepts a SINGLE-element list — `['audio']` for a
    // voice call OR `['text']` for text-only. The combined value is rejected
    // by the runtime ("Invalid modalities"). Audio mode still emits parallel
    // `response.output_audio_transcript.*` events, so locking output to audio
    // doesn't cost us captions.
    this.sendSessionUpdate()

    if (!this.suppressOpeningResponse) {
      // Trigger the opening stand-up. Instructions tell the agent how to open.
      this.send({ type: 'response.create' })
    }

    this.state = 'active'
    this.emit({ type: 'state', state: 'active' })
  }

  /** Forward a base64 PCM16 24 kHz mono chunk to the model. The audio module
   *  produces these from raw mic frames; this is a thin passthrough. */
  sendAudio(base64Pcm16: string): void {
    if (this.state !== 'active') return
    if (!base64Pcm16) return
    this.send({ type: 'input_audio_buffer.append', audio: base64Pcm16 })
  }

  /** Cancel the in-flight response. With `server_vad` turn_detection (what
   *  we configure above) this is rarely needed — the server auto-cancels on
   *  `input_audio_buffer.speech_started`. Gated on `responseActive` so we
   *  never send a cancel the server will reject with "no active response". */
  cancelResponse(): void {
    if (this.state !== 'active') return
    if (!this.responseActive) return
    this.send({ type: 'response.cancel' })
  }

  /** Inject a narration phrase to be SPOKEN in the agent's voice.
   *
   *  This is the primitive the orchestrator uses to voice the executor's
   *  events. Two-step sequence:
   *    1. `conversation.item.create` adds a synthetic assistant message
   *       carrying the narration text. The model treats it as something it
   *       just said, preserving persona continuity.
   *    2. `response.create` with audio modality + an instruction to read the
   *       prior turn aloud produces the spoken rendering.
   *
   *  No-op while a response is already in flight — caller (narration module)
   *  is responsible for batching / queueing. Barge-in is handled by the
   *  server-VAD cancel path already wired below.
   *
   *  TODO(narration): the second-step instruction may want to be tunable per
   *  flow/high-level mode. Wire that through once the modes module lands. */
  injectNarration(text: string): void {
    if (this.state !== 'active') return
    if (!text) return
    if (this.responseActive) return

    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    })
    this.send({
      type: 'response.create',
      response: {
        output_modalities: ['audio'],
        instructions: 'Read the previous message aloud verbatim in your own voice.',
      },
    })
  }

  /** Ask the agent to produce a text-only wrap-up summary on hangup. Same
   *  two-step pattern as injectNarration, but `output_modalities: ['text']`
   *  so the user doesn't hear the recap read back. The accumulated text
   *  surfaces as a single `wrap-up-text` event on the next `response.done`. */
  requestWrapUp(prompt: string): void {
    if (this.state !== 'active') return
    if (this.wrapUpPending) return
    this.wrapUpPending = true
    this.wrapUpText = ''

    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      },
    })
    this.send({
      type: 'response.create',
      response: { output_modalities: ['text'] },
    })
  }

  /** Graceful hangup. Transitions through `closing` → `ended`. */
  close(): void {
    if (this.state === 'ended' || this.state === 'closing') return
    this.clientInitiatedClose = true
    this.state = 'closing'
    this.emit({ type: 'state', state: 'closing' })

    const socket = this.ws
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.close(1000, 'client hangup')
      } catch {
        /* swallow — we're tearing down anyway */
      }
    }
    // Synthetic close-state emit in case the real 'close' event lags or
    // never fires (network already gone). handleClose is idempotent.
    setTimeout(() => this.handleClose(1000, 'client hangup'), 0).unref?.()
  }

  // Build + send the `session.update` payload. Factored out so the voice
  // fallback path can resend it with `this.voice = DEFAULT_VOICE` after a
  // voice-not-available error.
  private sendSessionUpdate(): void {
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: this.model,
        output_modalities: ['audio'],
        instructions: this.instructions,
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice: this.voice,
            // `audio.output.speed` (OpenAI Realtime GA, range 0.25–1.5,
            // default 1.0). Omit when unset so the server applies its own
            // default rather than us echoing it back.
            ...(this.speed !== undefined ? { speed: this.speed } : {}),
          },
        },
      },
    })
  }

  private send(obj: unknown): void {
    const socket = this.ws
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    try {
      socket.send(JSON.stringify(obj))
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : err },
        'realtime: ws send failed',
      )
    }
  }

  private emit(ev: RealtimeEvent): void {
    try {
      this.onEvent(ev)
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : err }, 'realtime: onEvent threw')
    }
  }

  private handleSocketError(err: Error): void {
    if (this.state === 'closing' || this.state === 'ended') return
    this.logger.warn({ err: err?.message || err }, 'realtime: ws error')
    this.state = 'error'
    this.emit({ type: 'error', message: err?.message || String(err) })
    // Safety net: ws normally fires 'close' immediately after 'error', but a
    // delayed close leaves the session stuck. Schedule a synthetic
    // handleClose to guarantee state:'ended' fires. handleClose is idempotent.
    setTimeout(() => {
      if (this.state !== 'ended') this.handleClose(0, 'ws-error-fallback')
    }, 500).unref?.()
  }

  private handleServerMessage(data: WebSocket.RawData): void {
    let msg: ServerEvent
    try {
      msg = JSON.parse(data.toString('utf-8')) as ServerEvent
    } catch {
      this.logger.warn(
        { raw: data.toString('utf-8').slice(0, 300) },
        'realtime: server msg parse fail',
      )
      return
    }
    if (msg.type === 'error') {
      this.logger.warn({ ev: msg }, 'realtime: server error event')
    }
    this.handleServerEvent(msg)
  }

  private handleServerEvent(ev: ServerEvent): void {
    switch (ev.type) {
      case 'session.created':
      case 'session.updated':
        return

      case 'error': {
        const message = ev.error?.message || ev.message || 'OpenAI Realtime error'
        if (isBenignCancelRace(message, ev.error?.code)) {
          this.logger.debug({ message }, 'realtime: benign cancel race, swallowed')
          return
        }
        // Voice-not-available fallback. If the requested voice isn't on this
        // account, the server rejects the session.update with a voice-shaped
        // error. We retry once with DEFAULT_VOICE and swallow the original
        // error so the user just hears the agent in alloy instead of seeing
        // a startup failure. Only triggers when:
        //   - we haven't already retried, AND
        //   - we aren't already on DEFAULT_VOICE.
        if (
          !this.voiceFallbackTried &&
          this.voice !== DEFAULT_VOICE &&
          isVoiceUnavailable(message, ev.error?.code)
        ) {
          this.voiceFallbackTried = true
          const requested = this.voice
          this.voice = DEFAULT_VOICE
          this.logger.warn(
            { requested, fallback: DEFAULT_VOICE, message },
            'realtime: voice unavailable; retrying session.update with default voice',
          )
          this.sendSessionUpdate()
          return
        }
        this.emit({
          type: 'error',
          message,
          ...(ev.error?.code ? { code: ev.error.code } : {}),
        })
        return
      }

      case 'input_audio_buffer.speech_started':
        this.emit({ type: 'speech-started' })
        return

      case 'input_audio_buffer.speech_stopped':
        this.emit({ type: 'speech-stopped' })
        return

      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = ev.transcript
        if (typeof transcript === 'string' && transcript.trim()) {
          this.emit({ type: 'caption', role: 'user', text: transcript.trim(), final: true })
        }
        return
      }

      case 'response.output_audio.delta':
        if (typeof ev.delta === 'string' && ev.delta) {
          this.emit({ type: 'audio-chunk', audio: ev.delta })
        }
        return

      case 'response.output_audio.done':
        // GA note: this arrives without audio bytes — those came in the delta
        // stream. We only need it as an end-of-audio marker.
        this.emit({ type: 'audio-done' })
        return

      case 'response.output_audio_transcript.delta':
        if (typeof ev.delta === 'string' && ev.delta) {
          this.emit({ type: 'caption', role: 'assistant', text: ev.delta, final: false })
        }
        return

      case 'response.output_audio_transcript.done':
        if (typeof ev.transcript === 'string') {
          this.emit({ type: 'caption', role: 'assistant', text: ev.transcript, final: true })
        }
        return

      // Text-only modality output for the wrap-up turn. We don't surface
      // streaming text; just accumulate so we have the final string ready
      // when response.done fires.
      case 'response.output_text.delta':
      case 'response.text.delta':
        if (this.wrapUpPending && typeof ev.delta === 'string') {
          this.wrapUpText += ev.delta
        }
        return

      case 'response.output_text.done':
      case 'response.text.done':
        // .done carries the full final text; replace the accumulator so a
        // partial delta + a complete .done don't end up doubled.
        if (this.wrapUpPending && typeof ev.text === 'string') {
          this.wrapUpText = ev.text
        }
        return

      case 'response.created':
        // Server began generating a response. Tracked so cancelResponse()
        // (and any future caller) can no-op when nothing is in flight.
        this.responseActive = true
        return

      case 'response.done':
        this.responseActive = false
        if (this.wrapUpPending) {
          const text = this.wrapUpText
          this.wrapUpPending = false
          this.wrapUpText = ''
          this.emit({ type: 'wrap-up-text', text })
          return
        }
        this.emit({
          type: 'response-done',
          ...(ev.response?.status ? { status: ev.response.status } : {}),
        })
        return

      case 'response.cancelled':
        // With server_vad the server auto-cancels on user speech_started and
        // emits this event. No further state change needed — the speaker
        // flush already happened locally off the `speech-started` event.
        this.responseActive = false
        return

      // Rate limits + low-level housekeeping; intentionally ignored.
      case 'rate_limits.updated':
      case 'conversation.item.created':
      case 'conversation.item.added':
      case 'conversation.item.done':
      case 'response.output_item.added':
      case 'response.output_item.done':
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'input_audio_buffer.committed':
        return

      default:
        // Unknown events: don't crash. Forward-compatible with future API.
        return
    }
  }

  private handleClose(code: number, reason: string): void {
    if (this.state === 'ended') return
    if (!this.clientInitiatedClose) {
      this.logger.warn({ code, reason }, 'realtime: server-initiated close')
    }
    this.state = 'ended'
    this.responseActive = false
    this.wrapUpPending = false
    this.wrapUpText = ''
    this.emit({
      type: 'state',
      state: 'ended',
      code,
      reason,
      clientInitiated: this.clientInitiatedClose,
    })
    this.ws = null
  }
}

// "Cancellation failed: no active response found" — emitted by OpenAI when a
// response.cancel arrives after the response has already finished. Benign
// race that callers can't fully prevent. Both the message + the documented
// error code are matched so we tolerate either surface shape.
function isBenignCancelRace(message: string, code: string | undefined): boolean {
  if (code === 'response_cancel_not_active') return true
  return /no active response/i.test(message)
}

// The voice-rejection error doesn't have a single documented code yet (the
// GA surface has shifted around `invalid_voice` / `voice_not_available` /
// `voice_unavailable`). Match either family of codes OR a voice-shaped
// message. We're conservative: the predicate only matters when we're about
// to retry, and the retry itself is bounded to one attempt.
function isVoiceUnavailable(message: string, code: string | undefined): boolean {
  if (code && /voice/i.test(code)) return true
  return /\bvoice\b.*\b(not\s*available|unavailable|invalid|unknown|not\s*found)\b/i.test(message)
}
