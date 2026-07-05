/**
 * insertBounded — maintain `list` sorted desc by `scoreOf`, trimmed to
 * `limit`. O(limit) per insert instead of retaining every scanned item just
 * to sort-and-slice once at the end.
 *
 * Shared by audit-page-weight.mjs and audit-text-html-ratio.mjs, which both
 * used to keep an unbounded `samples`/`rawSamples` array across the full
 * dist/ walk (millions of pages) purely to derive a top-N view at report
 * time — the anti-pattern behind the `JSON.stringify` "Invalid string
 * length" crash once dist/ passed ~2.8M pages. To keep the SMALLEST N by
 * some metric (e.g. lowest text/HTML ratio), pass a negated `scoreOf`.
 *
 * @param {Array<unknown>} list
 * @param {unknown} item
 * @param {number} limit
 * @param {(item: unknown) => number} scoreOf
 */
export function insertBounded(list, item, limit, scoreOf) {
  const score = scoreOf(item);
  let i = list.length;
  while (i > 0 && scoreOf(list[i - 1]) < score) i--;
  list.splice(i, 0, item);
  if (list.length > limit) list.length = limit;
}
