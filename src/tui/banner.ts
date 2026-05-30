// Kazoo TUI banner.
//
// ASCII translation of the logo at assets/logo.png:
//   - Horizontal kazoo glyph (mint-teal): a long tube with a central
//     resonator box. Inside the box sit three dots — the static `···`
//     for now; this is also the speaking indicator (future: animate
//     when the narrator is voicing).
//   - Pixel KAZOO wordmark (white): hand-laid 5×5 block letters with
//     a 1-cell gap between glyphs.
//
// Palette (matches the PNG):
//   BRAND_TEAL  #3CE0A0  — the tube + box outline
//   white                — the wordmark + the ··· dots (high contrast
//                          inside the teal box, same as the logo)
//
// The glyph's middle row is exported as three separate segments so
// `Banner` in App.tsx can color the dots independently from the box.

/** Brand mint-teal — the logo's accent color. */
export const BRAND_TEAL = '#3CE0A0'

// ────── kazoo glyph ──────
//             ┏━━━━━┓
// ━━━━━━━━━━━━┫ ··· ┣━━━━━━━━━━━━
//             ┗━━━━━┛
//
// 29 cols wide so it sits flush with the wordmark below. The resonator
// box is 7 chars wide, centered (11 chars of tube on each side).

export const KAZOO_GLYPH_TOP = '            ┏━━━━━┓'
export const KAZOO_GLYPH_MID_LEFT = '━━━━━━━━━━━━┫ '
export const KAZOO_GLYPH_MID_DOTS = '···'
export const KAZOO_GLYPH_MID_RIGHT = ' ┣━━━━━━━━━━━━'
export const KAZOO_GLYPH_BOTTOM = '            ┗━━━━━┛'

// ────── KAZOO wordmark ──────
//   █   █  ███  █████  ███   ███
//   █  █  █   █    █  █   █ █   █
//   ███   █████   █   █   █ █   █
//   █  █  █   █  █    █   █ █   █
//   █   █ █   █ █████  ███   ███
//
// 5 letters × 5-cell-wide pixel grids + 1-cell gaps = 29 cols.
// Stored as an array (joined on render) so future tweaks read clean.

export const KAZOO_WORDMARK_LINES: readonly string[] = [
  '█   █  ███  █████  ███   ███',
  '█  █  █   █    █  █   █ █   █',
  '███   █████   █   █   █ █   █',
  '█  █  █   █  █    █   █ █   █',
  '█   █ █   █ █████  ███   ███',
]

/** Full wordmark as a single newline-joined string. */
export const KAZOO_WORDMARK = KAZOO_WORDMARK_LINES.join('\n')

/** Plain-text preview (for non-Ink callers — README diff, smoke tests). */
export const KAZOO_BANNER_PLAIN = [
  KAZOO_GLYPH_TOP,
  `${KAZOO_GLYPH_MID_LEFT}${KAZOO_GLYPH_MID_DOTS}${KAZOO_GLYPH_MID_RIGHT}`,
  KAZOO_GLYPH_BOTTOM,
  ...KAZOO_WORDMARK_LINES,
].join('\n')
