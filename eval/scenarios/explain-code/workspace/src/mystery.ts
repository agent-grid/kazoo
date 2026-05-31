// A binary search over a sorted ascending number array.
// Returns the index of `target` if found, or -1 if not present.
//
// Edge case to notice: `lo + hi` is computed as `lo + ((hi - lo) >> 1)` to
// avoid integer overflow on very large arrays — the classic "off-by-one /
// midpoint overflow" guard. Also, `hi` is exclusive (`arr.length`, not
// `arr.length - 1`), so the loop condition is `lo < hi` and the not-found
// path returns -1 cleanly when the search interval collapses.
export function mystery(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1);
    const v = arr[mid];
    if (v === target) return mid;
    if (v < target) lo = mid + 1;
    else hi = mid;
  }
  return -1;
}
