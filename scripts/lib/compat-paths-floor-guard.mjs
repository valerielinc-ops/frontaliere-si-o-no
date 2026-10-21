/**
 * Shared floor-guard for the `data/seo-404-compat` accumulator (the 404→301
 * redirect engine; sharded across part-*.json since issue #2988,
 * formerly the single seo-404-compat-paths.json). Operates on path COUNTS, so
 * it is storage-shape-agnostic — callers pass prev/next totals. Prunes also
 * check route-family ratios to catch localized resolver regressions.
 *
 * Why this exists (2026-06-04, #404-truncation; #1353): the compat file is an
 * ACCUMULATOR written by MULTIPLE jobs:
 *   - scripts/discover-404s-via-inspection.mjs (full rewrite from a Set)
 *   - scripts/sync-gsc-orphans.mjs (feeds back orphan paths)
 *   - scripts/lib/resolve-404-compat-conflict.mjs (in-place rebase 3-way merge)
 * Each reads via a `readJsonSafe` that returns an EMPTY fallback (`{paths:[]}`)
 * on a corrupt/parse-fail/mid-write file. If that read silently degrades to
 * empty, the writer recomputes a tiny `paths` array and OVERWRITES the 657k
 * good paths with a few thousand → 404→301 resolver down in prod (observed:
 * commit 06546ba truncated 657594→0, main red, floor-test 150000 violated).
 *
 * Duplicating this guard inline in ≥2 files invites drift (AGENTS.md #6), so it
 * lives here once and every compat writer calls it before its `writeFileSync`.
 *
 * SEMANTICS (mirror of the original inline guard at
 * discover-404s-via-inspection.mjs ~L323-333): the guard fires ONLY when the
 * write would SHRINK an already-large file below the floor —
 *   nextCount < floor && prevCount >= floor
 * A genuinely-small file (prevCount < floor, e.g. first-ever bootstrap) is NOT
 * blocked, so a fresh/legitimately-small accumulator can still grow.
 */

export const COMPAT_PATHS_SANITY_FLOOR = 150_000;
export const COMPAT_PATHS_MAX_AUTO_PRUNE_COUNT = 50_000;
export const COMPAT_PATHS_MAX_AUTO_PRUNE_RATIO = 0.10;
export const COMPAT_PATHS_MAX_AUTO_PRUNE_FAMILY_RATIO = 0.25;
export const COMPAT_PATHS_MIN_AUTO_PRUNE_FAMILY_SIZE = 2;
export const COMPAT_PATHS_MIN_AUTO_PRUNE_RATIO_FAMILY_SIZE = 20;

const LOCALES = new Set(['de', 'en', 'fr', 'it']);

/**
 * Return the broad route family for an observed compatibility path.
 * Locale-prefixed and unprefixed paths remain separate families so a
 * resolver regression affecting one language cannot hide in the global total.
 */
export function compatPathFamily(path) {
  const pathname = String(path ?? '');
  const queryIndex = pathname.indexOf('?');
  const hashIndex = pathname.indexOf('#');
  const pathEnd = Math.min(
    queryIndex < 0 ? pathname.length : queryIndex,
    hashIndex < 0 ? pathname.length : hashIndex,
  );
  const firstStart = pathname.startsWith('/') ? 1 : 0;
  const firstSlash = pathname.indexOf('/', firstStart);
  const firstEnd = firstSlash < 0 || firstSlash > pathEnd ? pathEnd : firstSlash;
  const first = pathname.slice(firstStart, firstEnd).toLowerCase();
  const hasLocale = LOCALES.has(first);
  if (!hasLocale) return first || '<root>';

  const sectionStart = firstEnd < pathEnd ? firstEnd + 1 : firstEnd;
  const sectionSlash = pathname.indexOf('/', sectionStart);
  const sectionEnd = sectionSlash < 0 || sectionSlash > pathEnd ? pathEnd : sectionSlash;
  const section = pathname.slice(sectionStart, sectionEnd).toLowerCase() || '<root>';
  return `${first}/${section}`;
}

/**
 * Throw if writing `nextCount` paths would catastrophically truncate an
 * existing accumulator of `prevCount` paths.
 *
 * @param {number} prevCount  paths currently on disk (read pre-write)
 * @param {number} nextCount  paths about to be written
 * @param {object} [opts]
 * @param {number} [opts.floor=COMPAT_PATHS_SANITY_FLOOR]  sanity floor
 * @param {string} [opts.label='seo-404-compat-paths.json'] accumulator label for the message
 * @throws {Error} when nextCount < floor && prevCount >= floor
 */
export function assertCompatFloor(prevCount, nextCount, opts = {}) {
  const floor = opts.floor ?? COMPAT_PATHS_SANITY_FLOOR;
  const label = opts.label ?? 'seo-404-compat-paths.json';
  const prev = Number(prevCount) || 0;
  const next = Number(nextCount) || 0;
  if (next < floor && prev >= floor) {
    throw new Error(
      `❌ ABORT write to ${label}: ${next} path < floor ${floor} ` +
        `while the existing accumulator has ${prev} → catastrophic truncation avoided. ` +
        `The source read may be incomplete or the update may have removed a large cohort. ` +
        `NOT overwriting. Investigate the input, resolver, or writer and restore if needed.`
    );
  }
}

/**
 * Guard a destructive prune of the large compatibility accumulator.
 *
 * The historical floor catches a complete/truncating read failure, but alone
 * allows a resolver regression to drop a large cohort while leaving the store
 * above 150k. Automatic pruning is therefore limited to 50k paths and 10% of
 * the existing store. A reviewed, intentional large cleanup can explicitly
 * bypass both guards with `allowLargePrune: true`.
 *
 * @param {number} prevCount paths currently on disk
 * @param {number} nextCount paths about to be written
 * @param {object} [opts]
 * @param {string} [opts.label='seo-404-compat-paths.json'] accumulator label
 * @param {boolean} [opts.allowLargePrune=false] explicit reviewed override
 * @throws {Error} when an automatic prune exceeds either safety limit
 */
export function assertCompatPruneSafety(prevCount, nextCount, opts = {}) {
  if (opts.allowLargePrune === true) return;

  const label = opts.label ?? 'seo-404-compat-paths.json';
  assertCompatFloor(prevCount, nextCount, { ...opts, label });

  const prev = Number(prevCount) || 0;
  const next = Number(nextCount) || 0;
  if (prev < COMPAT_PATHS_SANITY_FLOOR) return;

  const removed = Math.max(0, prev - next);
  const removalRatio = removed / prev;
  if (removed > COMPAT_PATHS_MAX_AUTO_PRUNE_COUNT || removalRatio > COMPAT_PATHS_MAX_AUTO_PRUNE_RATIO) {
    throw new Error(
      `❌ ABORT prune of ${label}: ${removed} of ${prev} paths would be removed ` +
        `(${(removalRatio * 100).toFixed(1)}%). Automatic pruning is limited to ` +
        `${COMPAT_PATHS_MAX_AUTO_PRUNE_COUNT} paths and ` +
        `${COMPAT_PATHS_MAX_AUTO_PRUNE_RATIO * 100}% of a large accumulator. ` +
        `Review the dropped paths and resolver; only then rerun with ` +
        `PRUNE_404_ALLOW_LARGE_PRUNE=1 to authorize this cleanup.`,
    );
  }
}

/**
 * Guard against a localized resolver regression whose total loss is small
 * enough to pass the global count limits. `familyTotals` counts all paths
 * before pruning; `familyRemoved` counts the unresolved paths to be removed.
 *
 * @param {Map<string, number>} familyTotals
 * @param {Map<string, number>} familyRemoved
 * @param {object} [opts]
 * @param {string} [opts.label='seo-404-compat-paths.json']
 * @param {boolean} [opts.allowLargePrune=false]
 * @throws {Error} when a route family with at least 2 paths disappears, or a
 *                  family with at least 20 paths loses an unexpected cohort
 */
export function assertCompatPruneFamilySafety(familyTotals, familyRemoved, opts = {}) {
  if (opts.allowLargePrune === true) return;

  const label = opts.label ?? 'seo-404-compat-paths.json';
  if (!(familyTotals instanceof Map) || !(familyRemoved instanceof Map)) {
    throw new Error(
      `❌ ABORT prune of ${label}: route-family evidence is missing; ` +
        'refusing to write without checking localized path loss.',
    );
  }

  for (const [family, total] of familyTotals) {
    if (typeof family !== 'string' || family.length === 0 || !Number.isSafeInteger(total) || total < 0) {
      throw new Error(
        `❌ ABORT prune of ${label}: route-family evidence is invalid; ` +
          'expected non-negative safe-integer counts keyed by family.',
      );
    }
  }
  for (const [family, removed] of familyRemoved) {
    const total = familyTotals.get(family);
    if (!familyTotals.has(family) || !Number.isSafeInteger(removed) || removed < 0 || removed > total) {
      throw new Error(
        `❌ ABORT prune of ${label}: route-family evidence is inconsistent; ` +
          'every removed count must be between zero and its family total.',
      );
    }
  }

  const suspicious = [];
  for (const [family, total] of familyTotals) {
    const removed = familyRemoved.get(family) ?? 0;
    if (total <= 0) continue;
    const ratio = removed / total;
    const multiPathFamily = total >= COMPAT_PATHS_MIN_AUTO_PRUNE_FAMILY_SIZE;
    const ratioEstablishedFamily = total >= COMPAT_PATHS_MIN_AUTO_PRUNE_RATIO_FAMILY_SIZE;
    const entireFamilyRemoved = multiPathFamily && removed === total;
    const establishedFamilyLoss = ratioEstablishedFamily && ratio > COMPAT_PATHS_MAX_AUTO_PRUNE_FAMILY_RATIO;
    if (entireFamilyRemoved || establishedFamilyLoss) {
      suspicious.push({ family, removed, total, ratio });
    }
  }

  if (suspicious.length === 0) return;
  suspicious.sort((a, b) => b.removed - a.removed || a.family.localeCompare(b.family));
  const sample = suspicious.slice(0, 5)
    .map(({ family, removed, total, ratio }) => `${family}: ${removed}/${total} (${(ratio * 100).toFixed(1)}%)`)
    .join('; ');
  throw new Error(
    `❌ ABORT prune of ${label}: localized route-family loss exceeds ` +
      `${COMPAT_PATHS_MAX_AUTO_PRUNE_FAMILY_RATIO * 100}% for ${suspicious.length} family/families ` +
      `(complete loss is reviewed from ${COMPAT_PATHS_MIN_AUTO_PRUNE_FAMILY_SIZE} paths; ` +
      `>25% loss from ${COMPAT_PATHS_MIN_AUTO_PRUNE_RATIO_FAMILY_SIZE} paths). ` +
      `Review the dropped paths and resolver; only then rerun with ` +
      `PRUNE_404_ALLOW_LARGE_PRUNE=1 to authorize this cleanup. Sample: ${sample}`,
  );
}
