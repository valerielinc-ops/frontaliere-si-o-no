let cachedSource = null;
let cachedLineStarts = [];
/**
 * Resolve a zero-based source offset to its one-based line number.
 *
 * CI workflow files can be large and callers may resolve many matches in the
 * same source. Build the line-start index once per source and binary-search
 * it instead of rescanning every prefix with `slice().split()`.
 */
export function lineAt(source, index) {
  const text = String(source ?? '');
  const offset = Number.isFinite(index) ? Math.max(0, index) : 0;
  if (text !== cachedSource) {
    cachedSource = text;
    cachedLineStarts = [0];
    for (let newline = text.indexOf('\n'); newline >= 0; newline = text.indexOf('\n', newline + 1)) {
      cachedLineStarts.push(newline + 1);
    }
  }

  let low = 0;
  let high = cachedLineStarts.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (cachedLineStarts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}
