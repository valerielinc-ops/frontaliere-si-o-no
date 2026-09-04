/**
 * baseline-ratchet.mjs — compare a freshly written SEO baseline against the
 * committed one and decide whether the rewrite is a legitimate TIGHTENING.
 *
 * Why this exists (docs/SEO-GATES.md §4b, incident #5434→#5543): every
 * `npm run audit:*:rebaseline` script writes the current measurement over the
 * committed file. Nothing compares the new file with the old one. So a
 * rebaseline run on a corpus that is momentarily smaller — a partial shard
 * rehydrate, an audit bug, a feature bucket that vanished — freezes a WORSE
 * state into the ratchet permanently, and the gate loses the ability to ever
 * detect a regression back up to that level. That risk is the sole reason the
 * improvement path was left as "a human runs the command after reviewing the
 * data" (#5983, #7354), and the review never happened.
 *
 * The functions here turn that review into a mechanical check: a rebaseline is
 * accepted only when EVERY per-bucket entry is at least as strict as the one
 * it replaces and the scanned corpus did not shrink. Anything else is a
 * violation and the caller must restore the committed file.
 *
 * Shapes understood (the two the six cathedral gates actually use):
 *   - `byFeature`:  { <feature>: { scanned, offenders, ratePct } }
 *       text-html-ratio, title-length, title-no-disambig-hash, h1-title-duplicates
 *   - `perSitemap`: { <sitemap>: { total, orphans|atDepthGtMax, ratePct } }
 *       max-bfs-depth, orphan-sitemap-pages
 * Anything else returns `null` from `bucketsOf()` and is reported as
 * unsupported — never silently accepted.
 */

/** Per-bucket normalised view of a baseline entry. */
/**
 * @typedef {Object} Bucket
 * @property {number} scanned    corpus size for the bucket (0 when absent)
 * @property {number} offenders  failing pages in the bucket
 * @property {number} ratePct    offenders / scanned, as the baseline stores it
 */

/**
 * Read the offender count of a `perSitemap` / `byFeature` entry. The two
 * families name the same quantity differently (`offenders`, `orphans`,
 * `atDepthGtMax`); the first numeric one wins.
 *
 * @param {Record<string, unknown>} entry
 * @returns {number}
 */
function offendersOf(entry) {
  for (const key of ['offenders', 'orphans', 'atDepthGtMax']) {
    const v = entry[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return 0;
}

/**
 * Read the corpus size of an entry (`scanned` for byFeature, `total` for
 * perSitemap).
 *
 * @param {Record<string, unknown>} entry
 * @returns {number}
 */
function scannedOf(entry) {
  for (const key of ['scanned', 'total']) {
    const v = entry[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return 0;
}

/**
 * Normalise a baseline document into `{ bucket → Bucket }`.
 *
 * @param {unknown} baseline
 * @returns {Map<string, Bucket>|null} null when the shape is not one of the
 *   two supported families (caller must refuse the rebaseline, not accept it).
 */
export function bucketsOf(baseline) {
  const doc = /** @type {Record<string, unknown>} */ (baseline ?? {});
  const container = /** @type {Record<string, Record<string, unknown>>|undefined} */ (
    doc.byFeature ?? doc.perSitemap
  );
  if (!container || typeof container !== 'object') return null;

  /** @type {Map<string, Bucket>} */
  const buckets = new Map();
  for (const [name, raw] of Object.entries(container)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = /** @type {Record<string, unknown>} */ (raw);
    const scanned = scannedOf(entry);
    const offenders = offendersOf(entry);
    const ratePctRaw = entry.ratePct;
    const ratePct =
      typeof ratePctRaw === 'number' && Number.isFinite(ratePctRaw)
        ? ratePctRaw
        : scanned > 0
          ? (offenders / scanned) * 100
          : 0;
    buckets.set(name, { scanned, offenders, ratePct });
  }
  return buckets;
}

/**
 * @typedef {Object} RatchetOptions
 * @property {number} [maxCorpusShrinkPct] how much the total scanned corpus may
 *   shrink and still count as a real measurement rather than a truncated one.
 *   Default 5.
 * @property {number} [ratePctEpsilon] floating-point slack when comparing
 *   stored `ratePct` values. Default 1e-6.
 */

/**
 * @typedef {Object} RatchetVerdict
 * @property {boolean} ok               true → the new baseline may be committed
 * @property {string[]} violations      human-readable reasons to refuse
 * @property {string[]} newBuckets      buckets absent from the committed file
 * @property {number} tightenedBuckets  buckets whose offender count went down
 * @property {number} oldOffenders
 * @property {number} newOffenders
 * @property {number} oldScanned
 * @property {number} newScanned
 * @property {number} corpusDeltaPct    (new-old)/old × 100, 0 when old is 0
 */

/**
 * Decide whether `next` is a legitimate tightening of `current`.
 *
 * Strict by design: a single bucket that got looser refuses the whole file.
 * A rebaseline is not a place to trade one feature's regression against
 * another's improvement — that trade is what froze a regression into the
 * ratchet in #5434. When this returns `ok: false` the correct outcome is to
 * restore the committed baseline and leave the opportunity to a human, which
 * is exactly the status quo, so the check can only ever be safer than not
 * running it.
 *
 * @param {unknown} current committed baseline document
 * @param {unknown} next    freshly written baseline document
 * @param {RatchetOptions} [options]
 * @returns {RatchetVerdict}
 */
export function assertBaselineRatchet(current, next, options = {}) {
  const maxCorpusShrinkPct = options.maxCorpusShrinkPct ?? 5;
  const ratePctEpsilon = options.ratePctEpsilon ?? 1e-6;

  /** @type {string[]} */
  const violations = [];
  /** @type {string[]} */
  const newBuckets = [];
  let tightenedBuckets = 0;

  const oldBuckets = bucketsOf(current);
  const nextBuckets = bucketsOf(next);

  if (!oldBuckets || !nextBuckets) {
    violations.push(
      'unsupported baseline shape: expected a `byFeature` or `perSitemap` map in both the committed and the regenerated file',
    );
    return {
      ok: false,
      violations,
      newBuckets,
      tightenedBuckets: 0,
      oldOffenders: 0,
      newOffenders: 0,
      oldScanned: 0,
      newScanned: 0,
      corpusDeltaPct: 0,
    };
  }

  let oldOffenders = 0;
  let newOffenders = 0;
  let oldScanned = 0;
  let newScanned = 0;

  for (const [name, before] of oldBuckets) {
    oldOffenders += before.offenders;
    oldScanned += before.scanned;
    const after = nextBuckets.get(name);
    if (!after) {
      // A bucket that disappears is the artefact signature this guard exists
      // for: the pages are not "fixed", they were not measured. Exception: a
      // bucket that was empty to begin with carries no ratchet value.
      if (before.scanned > 0) {
        violations.push(
          `bucket \`${name}\` vanished from the regenerated baseline (was scanned=${before.scanned}, offenders=${before.offenders}) — the corpus was not fully measured`,
        );
      }
      continue;
    }
    if (after.offenders > before.offenders) {
      violations.push(
        `bucket \`${name}\` got LOOSER: offenders ${before.offenders} → ${after.offenders}`,
      );
    } else if (after.offenders < before.offenders) {
      tightenedBuckets += 1;
    }
    if (after.ratePct > before.ratePct + ratePctEpsilon) {
      violations.push(
        `bucket \`${name}\` got LOOSER: ratePct ${before.ratePct} → ${after.ratePct}`,
      );
    }
  }

  for (const [name, after] of nextBuckets) {
    newOffenders += after.offenders;
    newScanned += after.scanned;
    if (!oldBuckets.has(name)) newBuckets.push(name);
  }

  const corpusDeltaPct = oldScanned > 0 ? ((newScanned - oldScanned) / oldScanned) * 100 : 0;
  if (corpusDeltaPct < -maxCorpusShrinkPct) {
    violations.push(
      `scanned corpus shrank ${corpusDeltaPct.toFixed(2)}% (${oldScanned} → ${newScanned}), more than the ${maxCorpusShrinkPct}% allowed — the drop is more likely a truncated measurement than a content fix`,
    );
  }

  return {
    ok: violations.length === 0,
    violations,
    newBuckets,
    tightenedBuckets,
    oldOffenders,
    newOffenders,
    oldScanned,
    newScanned,
    corpusDeltaPct,
  };
}

/**
 * Render a verdict as the markdown block the workflow puts in the PR body and
 * the job summary.
 *
 * @param {string} gateName
 * @param {RatchetVerdict} verdict
 * @returns {string}
 */
export function formatRatchetVerdict(gateName, verdict) {
  const lines = [`### \`${gateName}\` — ${verdict.ok ? 'accepted' : 'REFUSED'}`, ''];
  lines.push(
    `- Offenders: ${verdict.oldOffenders} → ${verdict.newOffenders} (${verdict.tightenedBuckets} bucket(s) tightened)`,
  );
  lines.push(
    `- Scanned corpus: ${verdict.oldScanned} → ${verdict.newScanned} (${verdict.corpusDeltaPct.toFixed(2)}%)`,
  );
  if (verdict.newBuckets.length > 0) {
    lines.push(
      `- New buckets floored at their current value: ${verdict.newBuckets.map((b) => `\`${b}\``).join(', ')}`,
    );
  }
  for (const v of verdict.violations) lines.push(`- ❌ ${v}`);
  lines.push('');
  return lines.join('\n');
}
