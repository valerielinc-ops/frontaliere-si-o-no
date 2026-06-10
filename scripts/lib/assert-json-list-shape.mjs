/**
 * Shared non-silent guard for JSON-envelope job-list parsers.
 *
 * Extracted from the #1663 (🔴 Important) per-parser fix on
 * `parseSoliqueApiListing`, swept corpus-wide per #1666 / AGENTS.md #6
 * (a guard duplicated literally in ≥2 files → one shared module so drift is
 * impossible by-construction).
 *
 * ## The silent-failure class this kills
 *
 * ~12 funnel-critical crawler parsers do
 *
 *     const items = Array.isArray(data?.jobs) ? data.jobs : [];
 *
 * (or a key-variant: `data.data`, `content`, `items`, `jobPostings`). When the
 * upstream JSON envelope changes shape / lang / pagination, or returns an error
 * body (`{error: …}`, an HTML string, a bare array, `null`), `data[key]` stops
 * being an array and EVERY row falls through to `[]`. That outcome is
 * **indistinguishable from a board that is genuinely empty** → the crawler
 * "succeeds" with 0 jobs → the source's dataset is silently emptied → silent
 * loss of organic traffic. This is the same root pattern as the
 * canonical-sitemap escalation (#1347 / #1324): `writeJson(kept=[])` wiping a
 * previously-populated source without any loud signal.
 *
 * ## What this helper does (observability, contract-invariant)
 *
 * It is a **drop-in for the ternary** — it returns the array (or `[]`), so the
 * callers' control flow (pagination break-on-empty, `all.push(...items)`) is
 * UNCHANGED. The only added behaviour is a loud `console.warn` when the
 * envelope is malformed, so a shape/lang/pagination/error-body drift surfaces
 * immediately in the crawler logs (and is caught by the per-source health
 * signal) instead of decaying into a silent zero-job crawl.
 *
 * ## valid-empty vs malformed — the crucial distinction
 *
 *   - **valid empty board**: `data[key]` IS an array, just `length === 0`
 *     (e.g. `{ jobs: [], total: 0 }`). → returns `[]`, **no warn** — a source
 *     that genuinely has 0 openings keeps working silently.
 *   - **malformed / error envelope**: `data[key]` is NOT an array (missing key,
 *     renamed key, `data` is a string/number/null/bare-array/error-object).
 *     → returns `[]` (so the caller still degrades gracefully) but **warns
 *     loudly** describing the actual shape received.
 *
 * Because the guard NEVER throws, it does not crash the orchestrator or wipe a
 * source mid-pagination; the loud warn is the additive observability the issue
 * asks for. (Throwing would risk emptying a partially-paginated `all[]` and is
 * not the established repo pattern — #1663 used a non-silent warn with an
 * invariant return contract; the per-source quarantine / ratio-gate machinery
 * already reacts to a zero-job crawl, and the warn makes its cause legible.)
 */

/**
 * Describe the *actual* shape of a value for the warn message without printing
 * misleading index keys. For a plain object we list its envelope keys (that is
 * what reveals a rename / pagination wrapper); for a bare array we print its
 * length; for a primitive we print its `typeof`.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function describeJsonShape(value) {
  if (value == null) return String(value); // 'null' | 'undefined'
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (typeof value !== 'object') return typeof value;
  const keys = Object.keys(value);
  return `object (envelope keys: ${keys.join(', ') || 'none'})`;
}

/**
 * Validate that `data[key]` is an array and return it; warn loudly (without
 * throwing) when it is not. Drop-in replacement for
 * `Array.isArray(data?.[key]) ? data[key] : []`.
 *
 * @template T
 * @param {unknown} data - the parsed JSON envelope
 * @param {object} opts
 * @param {string} [opts.key='jobs'] - envelope key expected to hold the list
 * @param {string} opts.source - crawler/source id for the warn (e.g. 'usz')
 * @param {string} [opts.lang] - optional lang/locale segment for the warn
 * @param {(row: unknown) => boolean} [opts.rowShapeOk] - optional per-row
 *   structural predicate. When provided AND the list is non-empty, the FIRST
 *   row failing it triggers a separate "row shape mismatch" warn (a per-field
 *   rename that keeps the envelope but breaks every row is the same silent
 *   class). The predicate must test *structural presence*, not non-emptiness,
 *   so a legitimately-sparse/placeholder row does not false-warn.
 * @param {(msg: string) => void} [opts.warn=console.warn] - injectable for tests
 * @returns {T[]} the array (possibly empty); never throws
 */
export function assertJsonListShape(data, { key = 'jobs', source, lang, rowShapeOk, warn = console.warn } = {}) {
  const list = data == null ? undefined : data[key];
  const langSuffix = lang ? ` (${lang})` : '';

  if (!Array.isArray(list)) {
    warn(
      `⚠️ JSON list shape mismatch for ${source}${langSuffix}: expected an array at \`data.${key}\`, ` +
        `got ${describeJsonShape(data)} — the upstream JSON envelope may have changed shape, lang, ` +
        `paginated, or returned an error/empty body (this is NOT a genuinely-empty board, which would ` +
        `still expose \`data.${key}\` as an empty array).`,
    );
    return [];
  }

  // A non-empty list whose rows all fail the parser's structural predicate is a
  // per-row rename drift — silent in the same way (every row gets skipped).
  if (list.length > 0 && typeof rowShapeOk === 'function') {
    const firstBad = list.find((row) => !rowShapeOk(row));
    if (firstBad !== undefined) {
      const rowDesc =
        firstBad != null && typeof firstBad === 'object'
          ? `row keys: ${Object.keys(firstBad).join(', ') || 'none'}`
          : `row type: ${describeJsonShape(firstBad)}`;
      warn(
        `⚠️ JSON list row shape mismatch for ${source}${langSuffix}: a row among ${list.length} at ` +
          `\`data.${key}\` lacks the expected per-row shape (${rowDesc}) — per-job field names may have changed.`,
      );
    }
  }

  return list;
}

export default assertJsonListShape;
