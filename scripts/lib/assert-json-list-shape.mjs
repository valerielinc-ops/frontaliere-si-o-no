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
 * Emit the loud (non-throwing) "JSON list shape mismatch" warn shared by the
 * single-key {@link assertJsonListShape} and the multi-key
 * {@link assertJsonListShapeMultiKey}. Centralised so the message wording, the
 * `describeJsonShape` rendering, and the "this is NOT a genuinely-empty board"
 * clarification cannot drift between the two entry points (AGENTS.md #6).
 *
 * @param {string} expectation - what was expected, e.g. ``expected an array at
 *   `data.jobs` `` — phrasing the caller controls so single-key vs OR-chain read
 *   correctly.
 * @param {unknown} data - the actual envelope received (rendered via
 *   {@link describeJsonShape}).
 * @param {object} ctx
 * @param {string} ctx.source - crawler/source id
 * @param {string} [ctx.lang] - optional lang/locale segment
 * @param {(msg: string) => void} [ctx.warn=console.warn]
 */
export function warnJsonListShapeMismatch(expectation, data, { source, lang, warn = console.warn } = {}) {
  const langSuffix = lang ? ` (${lang})` : '';
  warn(
    `⚠️ JSON list shape mismatch for ${source}${langSuffix}: ${expectation}, ` +
      `got ${describeJsonShape(data)} — the upstream JSON envelope may have changed shape, lang, ` +
      `paginated, or returned an error/empty body (this is NOT a genuinely-empty board, which would ` +
      `still expose the list as an empty array).`,
  );
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
    warnJsonListShapeMismatch(`expected an array at \`data.${key}\``, data, { source, lang, warn });
    return [];
  }

  // A non-empty list whose rows all fail the parser's structural predicate is a
  // per-row rename drift — silent in the same way (every row gets skipped).
  if (list.length > 0 && typeof rowShapeOk === 'function') {
    // The predicate is caller-supplied; if it THROWS on an unexpected row shape
    // (e.g. reads a nested field off a primitive), that throw must NOT propagate
    // out of this helper — the docblock guarantees it never throws. A throwing
    // predicate is itself evidence the row shape drifted, so treat a throw as a
    // failed (malformed) row.
    const safeRowShapeOk = (row) => {
      try {
        return rowShapeOk(row);
      } catch {
        return false;
      }
    };
    const firstBad = list.find((row) => !safeRowShapeOk(row));
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

/**
 * Multi-key / OR-chain variant of {@link assertJsonListShape}.
 *
 * ## The idiom this kills
 *
 * The other half of the silent-`[]` class (the single-key ternary is killed by
 * {@link assertJsonListShape}) is the **multi-key OR-chain** a parser uses when
 * the upstream ATS exposes the list under one of several candidate keys, with a
 * bare-array fallthrough:
 *
 *     const items = data?.result || data?.jobs || data?.data
 *       || (Array.isArray(data) ? data : []);
 *
 * This degrades IDENTICALLY to the single-key ternary: if the envelope drifts
 * (key renamed, paginated wrapper, lang switch, error body) so that NONE of the
 * candidate keys is an array and `data` is not itself a bare array, the whole
 * chain collapses to `[]` — silently, indistinguishable from a genuinely-empty
 * board → 0 jobs → source silently emptied (#1347 / #1324 class).
 *
 * Worse, `||` resolves the first *truthy* operand, so a non-empty NON-array at a
 * candidate key (`{ jobs: { error: 'rate limited' } }`, `{ jobs: '<html>' }`)
 * would be returned AS the "list" and then iterated as if it were rows. This
 * variant resolves only the first candidate key whose value is a genuine ARRAY,
 * so such a malformed value is skipped (and warned) rather than mis-iterated.
 *
 * ## Contract (drop-in for the OR-chain, behaviour-invariant on valid envelopes)
 *
 *   - Resolves the FIRST candidate key in `keys` whose value is an array →
 *     returns it (no warn). Same resolved value as the `||` chain on a
 *     well-formed envelope where exactly one key holds the list.
 *   - If `allowBareArray` and `data` itself is a bare array → returns it
 *     (no warn). Covers the `(Array.isArray(data) ? data : [])` tail.
 *   - If NONE of the above match → returns `[]` (invariant return contract,
 *     never throws) and WARNS loudly, describing the actual envelope keys /
 *     shape received, exactly like the single-key path. This is the only added
 *     behaviour: total drift now surfaces in the logs instead of decaying to a
 *     silent zero-job crawl.
 *
 * A genuinely-empty board still passes SILENTLY: an envelope that exposes one of
 * the candidate keys as an EMPTY array resolves to `[]` with no warn (the
 * matched key wins before the "none match" branch).
 *
 * The warn logic is shared with {@link assertJsonListShape} via
 * {@link warnJsonListShapeMismatch} — no duplication (AGENTS.md #6).
 *
 * @template T
 * @param {unknown} data - the parsed JSON envelope
 * @param {object} opts
 * @param {string[]} opts.keys - candidate envelope keys, in priority order
 *   (first array-valued one wins). May be empty when only `allowBareArray`
 *   applies (pure bare-array API, à la Lever).
 * @param {boolean} [opts.allowBareArray=false] - accept a bare top-level array
 *   for `data` itself (mirrors the `(Array.isArray(data) ? data : [])` tail).
 * @param {string} opts.source - crawler/source id for the warn
 * @param {string} [opts.lang] - optional lang/locale segment for the warn
 * @param {(msg: string) => void} [opts.warn=console.warn] - injectable for tests
 * @returns {T[]} the resolved array (possibly empty); never throws
 */
export function assertJsonListShapeMultiKey(
  data,
  { keys = [], allowBareArray = false, source, lang, warn = console.warn } = {},
) {
  if (data != null && typeof data === 'object' && !Array.isArray(data)) {
    for (const key of keys) {
      // Support dotted candidate paths (e.g. OData's `d.results`) so a nested
      // wrapper is resolved without a bespoke ternary at the call site.
      const candidate = key.includes('.')
        ? key.split('.').reduce((acc, seg) => (acc == null ? undefined : acc[seg]), data)
        : data[key];
      if (Array.isArray(candidate)) return candidate;
    }
  }

  if (allowBareArray && Array.isArray(data)) return data;

  const keyList = keys.length ? `\`data.${keys.join('` / `data.')}\`` : '(none)';
  const bareNote = allowBareArray ? ' or a bare top-level array' : '';
  warnJsonListShapeMismatch(
    `expected an array at one of ${keyList}${bareNote}`,
    data,
    { source, lang, warn },
  );
  return [];
}

/**
 * RSS/XML-feed variant of {@link assertJsonListShape} for parsed-object RSS
 * envelopes (`parser.parse(xml)?.rss?.channel?.item`).
 *
 * ## Why RSS needs its own guard (and `assertJsonListShape` does NOT fit)
 *
 * An XML-to-object parser (e.g. `fast-xml-parser`) collapses a repeated element
 * to a **bare object** when there is exactly ONE `<item>`, and to an **array**
 * only when there are several. So `channel.item` being a non-array is the NORMAL,
 * legitimate single-job case — feeding it through {@link assertJsonListShape}
 * (which warns on any non-array) would FALSE-WARN every single-listing feed. The
 * established call-site idiom already normalises this:
 *
 *     const items = parsed?.rss?.channel?.item || [];
 *     const normalizedItems = Array.isArray(items) ? items : [items];
 *
 * The genuine silent-`[]` drift for RSS is therefore narrower than the JSON case:
 * the channel envelope is present but `item` is **entirely absent** (`undefined`/
 * `null`) — feed renamed the element, switched namespace, returned an error page,
 * or the `rss > channel` wrapper itself drifted. That collapses to `[]` and is
 * indistinguishable from a genuinely-empty board (no `<item>` at all).
 *
 * ## Contract (drop-in, returns the same normalised array the call sites built)
 *
 *   - `channel.item` is an array → returns it (no warn).
 *   - `channel.item` is a single bare object → returns `[item]` (no warn — the
 *     legitimate one-listing feed).
 *   - `rss.channel` is itself an ARRAY (multi-channel feed) → the single-channel
 *     access `channel.item` would be `undefined`, silently emptying the source.
 *     Instead we aggregate `item` across EVERY channel (preserving all listings)
 *     and **warn** — a feed turning multi-channel is a shape drift the crawler
 *     must see, but dropping the jobs would be the very silent-`[]` loss this
 *     module exists to kill.
 *   - `channel.item` is absent/null:
 *       - if the `rss > channel` envelope is itself missing/malformed → **warn**
 *         (the feed shape drifted) and return `[]`.
 *       - if the channel IS present but simply has no `item` → return `[]`
 *         **without warn** (a genuinely-empty feed still parses to a channel with
 *         no items; warning here would be noise on every closed board).
 *
 * Never throws. Warn wording is shared via {@link warnJsonListShapeMismatch}.
 *
 * @param {unknown} parsed - the object returned by the XML parser
 * @param {object} opts
 * @param {string} opts.source - crawler/source id for the warn
 * @param {string} [opts.lang]
 * @param {(msg: string) => void} [opts.warn=console.warn]
 * @returns {object[]} the normalised item array (possibly empty); never throws
 */
export function assertRssChannelItems(parsed, { source, lang, warn = console.warn } = {}) {
  const rss = parsed == null ? undefined : parsed.rss;
  const channel = rss == null ? undefined : rss.channel;

  // Multi-channel feed: `rss.channel` is an ARRAY of channels rather than a
  // single channel object. The single-channel `channel.item` access below would
  // be `undefined` → the source would silently empty out (the exact silent-`[]`
  // class this module kills). Aggregate `item` across every channel, normalising
  // each (array stays, single bare object → `[obj]`), so no listing is dropped,
  // and warn so the shape drift surfaces in the crawler logs.
  if (Array.isArray(channel)) {
    const items = channel.flatMap((ch) => {
      const it = ch == null ? undefined : ch.item;
      if (Array.isArray(it)) return it;
      if (it != null && typeof it === 'object') return [it];
      return [];
    });
    warn(
      `⚠️ JSON list shape mismatch for ${source}${lang ? ` (${lang})` : ''}: expected a single ` +
        `\`rss.channel\` but the RSS feed is multi-channel (${channel.length} channels) — ` +
        `aggregated ${items.length} item(s) across all channels. The feed shape may have drifted ` +
        `(this is NOT a genuinely-empty board, which would still expose a single channel).`,
    );
    return items;
  }

  const item = channel == null ? undefined : channel.item;

  if (Array.isArray(item)) return item;
  if (item != null && typeof item === 'object') return [item]; // single-listing feed

  // No items. Warn ONLY when the `rss` root envelope itself is missing (the real
  // drift: an error page / HTML body / renamed root parsed to something with no
  // `rss`). A present `rss` whose channel is empty (`<channel></channel>` →
  // `channel: ""`, or a channel with metadata but zero `<item>`) is a legit
  // closed board and must stay SILENT — warning there would be noise on every
  // source with no current openings.
  if (rss == null) {
    warnJsonListShapeMismatch(
      'expected an `rss.channel.item` array (or single item) in the RSS feed',
      parsed,
      { source, lang, warn },
    );
  }
  return [];
}

export default assertJsonListShape;
