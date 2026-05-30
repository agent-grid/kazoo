// Ambient types for the AudioWorklet GLOBAL SCOPE.
//
// `lib.dom.d.ts` describes the *main-thread* view of the Web Audio API
// (`AudioWorkletNode`, `BaseAudioContext.audioWorklet`, …), but it does NOT
// declare the runtime that exists INSIDE a worklet module: the
// `AudioWorkletProcessor` base class as a value to `extends`, the
// `registerProcessor` global, or the per-render-quantum `currentFrame` /
// `currentTime` / `sampleRate` globals. The worklet runs in its own
// `AudioWorkletGlobalScope`, which TS has no built-in lib for.
//
// This file supplies exactly the surface `mic-worklet.ts` touches. It is
// ambient (no imports/exports at the top level) so it augments the global
// scope for the whole `tsconfig.web` project — harmless for the rest of the
// renderer, which never references these names. (SURFACE_PLAN §1: `worklet.d.ts`
// for the `AudioWorkletProcessor` ambient.)

/** The processor's I/O for one render quantum. `inputs[input][channel]` is a
 *  128-sample `Float32Array` (or absent if the input is disconnected). */
interface AudioWorkletProcessorImpl {
  readonly port: MessagePort
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean
}

interface AudioWorkletProcessorConstructor {
  new (options?: AudioWorkletNodeOptions): AudioWorkletProcessorImpl
}

/** The base class every worklet processor extends. Provided as a runtime VALUE
 *  by the worklet global scope. */
declare const AudioWorkletProcessor: AudioWorkletProcessorConstructor

/** Register a processor class under a name the main thread passes to
 *  `new AudioWorkletNode(ctx, name)`. */
declare function registerProcessor(
  name: string,
  processorCtor: AudioWorkletProcessorConstructor,
): void

/** The sample rate of the `AudioContext` that loaded this worklet (Hz). For
 *  Kazoo's capture context this is 24000 (we request it explicitly). */
declare const sampleRate: number

/** Frames elapsed since the context started (advances by 128 per quantum). */
declare const currentFrame: number

/** The context's audio clock, in seconds. */
declare const currentTime: number
