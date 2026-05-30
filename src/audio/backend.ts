// Audio backend detection.
//
// Phase 0 strategy is subprocess-based: we shell out to one of two
// well-trodden Unix audio toolchains and pipe PCM16 LE @ 24 kHz mono in/out
// over stdin/stdout. No native dependency, no node-gyp, no Bun-FFI work.
//
// Preference order:
//   1. sox        (`rec` + `play`). Cross-platform — macOS + Linux. Default.
//   2. ALSA tools (`arecord` + `aplay`). Linux fallback.
//
// We require BOTH halves of a backend to be installed; we don't mix a sox
// mic with an aplay speaker (would work, but the diagnostic story when
// something goes wrong is cleaner if we stay within one toolchain).
//
// When swapping to a native binding later (naudiodon / `mic`+`speaker`),
// keep the same `AudioBackend` shape — the spawn-arg producers are inert
// data that a native impl just ignores.

import { KazooError } from '../lib/errors.ts'
import { SAMPLE_RATE_HZ } from './format.ts'

export type SpawnSpec = {
  command: string
  args: readonly string[]
}

export type AudioBackend = {
  kind: 'sox' | 'alsa'
  /** Records 24 kHz mono PCM16 LE raw bytes to stdout. */
  mic: SpawnSpec
  /** Plays 24 kHz mono PCM16 LE raw bytes from stdin. */
  speaker: SpawnSpec
}

/** Detect which subprocess toolchain is installed. Throws a `KazooError`
 *  with install instructions if neither is found. */
export function detectBackend(): AudioBackend {
  if (Bun.which('rec') && Bun.which('play')) return soxBackend()
  if (Bun.which('arecord') && Bun.which('aplay')) return alsaBackend()
  throw new KazooError(
    'audio/device',
    [
      'No supported audio tooling found on PATH.',
      'Install one of:',
      '  • sox (provides `rec` + `play`) — `brew install sox` on macOS, ' +
        '`apt install sox` on Debian/Ubuntu, `pacman -S sox` on Arch.',
      '  • alsa-utils (Linux only — provides `arecord` + `aplay`) — ' + '`apt install alsa-utils`.',
    ].join('\n'),
  )
}

function soxBackend(): AudioBackend {
  // sox flags decoded:
  //   -q                : quiet (no progress meter on stderr)
  //   -t raw            : headerless PCM
  //   -b 16             : 16-bit samples
  //   -e signed-integer : signed PCM (matches Int16Array semantics)
  //   -c 1              : mono
  //   -r <rate>         : sample rate in Hz
  //   -L                : little-endian
  //   -                 : stdin (play) / stdout (rec)
  const rate = String(SAMPLE_RATE_HZ)
  const common = [
    '-q',
    '-t',
    'raw',
    '-b',
    '16',
    '-e',
    'signed-integer',
    '-c',
    '1',
    '-r',
    rate,
    '-L',
    '-',
  ]
  return {
    kind: 'sox',
    mic: { command: 'rec', args: common },
    speaker: { command: 'play', args: common },
  }
}

function alsaBackend(): AudioBackend {
  // arecord/aplay flags:
  //   -q              : quiet
  //   -t raw          : headerless
  //   -f S16_LE       : 16-bit signed little-endian
  //   -c 1            : mono
  //   -r <rate>       : sample rate
  const rate = String(SAMPLE_RATE_HZ)
  const common = ['-q', '-t', 'raw', '-f', 'S16_LE', '-c', '1', '-r', rate]
  return {
    kind: 'alsa',
    mic: { command: 'arecord', args: common },
    speaker: { command: 'aplay', args: common },
  }
}
