import { zipSync } from "fflate";
import { createHash } from "node:crypto";

// Zip timestamps must fall in 1980-2099; use a fixed in-range date so identical
// inputs always produce identical bytes — and therefore the same hash. This is
// what makes the ts-to-zip hash check reproducible.
const FIXED_MTIME = new Date("1980-01-01T00:00:00Z");

export function deterministicZip(files: Record<string, Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const name of Object.keys(files).sort()) entries[name] = files[name];
  return zipSync(entries, { mtime: FIXED_MTIME, level: 6 });
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
