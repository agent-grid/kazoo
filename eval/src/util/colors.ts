// Tiny ANSI color helper — no dependencies. Colors auto-disable when stdout is
// not a TTY or when NO_COLOR is set (https://no-color.org).
const enabled = (!!process.stdout.isTTY || !!process.env.FORCE_COLOR) && !process.env.NO_COLOR;

const wrap =
  (...codes: number[]) =>
  (s: string | number): string =>
    enabled ? `\x1b[${codes.join(";")}m${s}\x1b[0m` : String(s);

export const c = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  cyan: wrap(36),
  gray: wrap(90),
  boldCyan: wrap(1, 36),
};
