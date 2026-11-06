/**
 * Resolve the first PARSEABLE date among a priority-ordered list of candidate
 * values, returning its epoch-ms timestamp (or 0 when none parse).
 *
 * Why not just `Date.parse(a || b || c)`: that picks the first *truthy* value,
 * not the first *parseable* one. ~0.3% of crawled jobs carry a malformed
 * `postedDate` (e.g. "30/05/26", DD/MM/YY → Invalid Date) that would shadow a
 * perfectly good `crawledAt`/`firstSeenAt` and collapse the timestamp to 0 —
 * making the job look infinitely old (mirrors the `toDateValue` hardening in
 * services/newsletter-content.mjs). Falling through to the next candidate keeps
 * date-derived signals (freshness counts, recency sorts) correct.
 *
 * @param values candidate date values in priority order (most-trusted first)
 * @returns epoch milliseconds of the first value that parses, else 0
 */
export function firstParsableMs(...values: unknown[]): number {
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    const ts = new Date(v as string | number | Date).getTime();
    if (Number.isFinite(ts)) return ts;
  }
  return 0;
}

/**
 * Like {@link firstParsableMs} but returns the original RAW value (as a string)
 * of the first candidate that parses, else ''. Use when downstream code needs
 * the source date string (display formatting, relative-label, slice(0,10))
 * rather than a timestamp — so a malformed first field doesn't reach a string
 * consumer and render "Invalid Date" / a broken freshness badge.
 *
 * @param values candidate date values in priority order (most-trusted first)
 * @returns the first value (stringified) that parses, else ''
 */
export function firstParsableDateStr(...values: unknown[]): string {
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    if (Number.isFinite(new Date(v as string | number | Date).getTime())) return String(v);
  }
  return '';
}
