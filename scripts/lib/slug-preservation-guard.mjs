/**
 * scripts/lib/slug-preservation-guard.mjs
 *
 * Makes losing a `previousSlug` impossible BY CONSTRUCTION, at the one place
 * every job slice has to pass through to become durable: the atomic write.
 *
 * ── Why this exists (issue #5157) ────────────────────────────────────────
 *
 * A lost previousSlug is a lost redirect: an URL Google already indexed
 * starts answering 404, and the organic traffic that URL had earned is gone.
 * It is the kind of loss nobody notices until it is irrecoverable.
 *
 * Before this module, slug history was protected by CONVENTION: crawlers were
 * expected to call `addPreviousSlugForLocale` / `captureLostSlugs`
 * (scripts/lib/dedicated-crawler-common.mjs) before overwriting a slug, and
 * those helpers journal into scripts/lib/slug-history-journal.mjs. The
 * convention worked exactly as well as conventions ever do. The recovery
 * workflow's 24h tripwire fired at 79 losses against a threshold of 10,
 * spread thinly across 21 commits and a dozen different crawlers — the
 * signature of a rule many authors independently forget, not of one broken
 * commit.
 *
 * The concrete bypass behind #5157: a slice can be rewritten from freshly
 * crawled jobs WITHOUT the old job's state ever reaching a journaling helper.
 * When the merge-with-existing step does not match a job (or is skipped
 * entirely), the fresh record simply replaces the old one. Observed on
 * banca-cler.json job `company-sbman6` in commit 8b8b68208b:
 *
 *     BEFORE  slugByLocale = { it: <it-slug>,
 *                              en: individual-customer-advisor-lugano-…,
 *                              de: individueller-kundenberater-lugano-…,
 *                              fr: conseiller-client-individuel-lugano-… }
 *     AFTER   slugByLocale = { it: <it-slug>, en: <it-slug>,
 *                              de: <it-slug>, fr: <it-slug> }
 *
 * Three live, indexed, translated URLs vanished. `previousSlugs` was never
 * touched, so nothing in the previousSlugs-focused tooling could see it: the
 * loss was in the ACTIVE slug fields. No journal helper was called, so there
 * was no journal entry either — the loss was silent by construction.
 *
 * ── What this module does ────────────────────────────────────────────────
 *
 * It refuses to let a slice write DROP a slug. On every write to
 * `data/jobs/by-crawler/*.json` it diffs the payload against the version
 * already on disk and, for every job present in both, re-captures any slug
 * that was reachable before (active or archived) but is not reachable after —
 * into `previousSlugsByLocale` under the locale it belonged to, journaled as
 * a `restore` mutation.
 *
 * That inverts the failure mode. Forgetting to journal is no longer a silent
 * SEO loss; it is a `restore` event with the offending writer's file path
 * attached. The rule is enforced at the boundary instead of asked for at ~40
 * call sites, which is what `writeJsonAtomic` itself already does for
 * atomicity ("Keeping it in one module makes the atomic guarantee impossible
 * to drift away from by copy-paste" — same argument, same chokepoint).
 *
 * Deliberately NOT resurrected:
 *   - slugs on the decontamination denylist (data/prev-slug-restore-denylist.json)
 *     — those were removed on purpose (#4055/#4056) and restoring them would
 *     re-inject the exact poison the decontamination deleted;
 *   - slugs evicted because a bucket is legitimately at cap — that is the
 *     documented LRU behaviour of capSlugArray, journaled as `cap-trim`, and
 *     `scan-prev-slug-losses.mjs` already classifies it as not-a-loss.
 *
 * Escape hatch: scripts that delete slug history ON PURPOSE (decontamination,
 * denylist building) set SLUG_PRESERVATION_GUARD=off for their own process.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveJobDiffKey } from './job-match-key.mjs';
import { recordSlugMutation } from './slug-history-journal.mjs';

/** Locales carrying their own slug bucket. Mirrors dedicated-crawler-common's
 *  LOCALES, duplicated here on purpose: this module must stay a leaf so the
 *  atomic writer can import it without an import cycle. */
const LOCALES = ['it', 'en', 'de', 'fr'];

/** Per-locale previousSlugs cap. Mirrors DEFAULT_PREV_SLUG_CAP. */
export const GUARD_PER_LOCALE_CAP = 20;

/** Flat legacy `previousSlugs` cap — scales with the number of locale buckets
 *  it unions (issue #3630/#3587: capping the union at the single-locale value
 *  collapsed the flat array the instant any per-locale capture fired). */
export const GUARD_LEGACY_CAP = GUARD_PER_LOCALE_CAP * LOCALES.length;

/** Only slices under this directory are guarded — the same surface
 *  `scripts/scan-prev-slug-losses.mjs` monitors, so the guard and the
 *  tripwire can never disagree about what counts as a loss. */
const GUARDED_DIR = path.join('data', 'jobs', 'by-crawler');

let _denylistCache = null;

function normalize(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Same key shape as backfill-prev-slugs-from-loss-events.mjs's denylistKey. */
function denylistKey(file, slug) {
  return `${file}\u0000${slug}`;
}

/**
 * Load data/prev-slug-restore-denylist.json — slugs deleted ON PURPOSE that
 * must never be restored. Read directly (not imported from the backfill
 * script) to keep this module a dependency-light leaf.
 *
 * @param {string} root repository root
 * @returns {Set<string>} denylistKey(file, slug) entries
 */
export function loadGuardDenylist(root) {
  if (_denylistCache) return _denylistCache;
  const file = path.join(root, 'data', 'prev-slug-restore-denylist.json');
  const set = new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const e of parsed?.entries || []) {
      if (e && e.file && e.slug) set.add(denylistKey(e.file, e.slug));
    }
  } catch {
    /* absent or unparsable denylist → guard everything (fail open, never throw
       inside a write) */
  }
  _denylistCache = set;
  return set;
}

/** Test seam: drop the memoized denylist. */
export function _resetDenylistCache() {
  _denylistCache = null;
}

/**
 * Run synchronous `fn` with SLUG_PRESERVATION_GUARD forced 'off', restoring
 * whatever value the env var held before (even if `fn` throws). Scripts that
 * intentionally delete previousSlugs history (decontamination, denylist
 * `--clean`) call this around the specific `writeJsonAtomic` call, never as a
 * module-load-time assignment: a top-level `process.env.SLUG_PRESERVATION_GUARD
 * = 'off'` leaks into any test file that imports the module for a pure helper
 * and shares a vitest worker (`isolate: true` sandboxes module state, not the
 * live `process.env`) — silently disabling the guard for every other
 * slug-write test scheduled to that worker for the rest of the run.
 *
 * @param {() => any} fn
 * @returns {any} fn's return value
 */
export function withGuardOff(fn) {
  const prev = process.env.SLUG_PRESERVATION_GUARD;
  process.env.SLUG_PRESERVATION_GUARD = 'off';
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.SLUG_PRESERVATION_GUARD;
    else process.env.SLUG_PRESERVATION_GUARD = prev;
  }
}

/** True when `filePath` is a per-crawler job slice. */
export function isGuardedSlicePath(filePath) {
  const normalized = path.normalize(String(filePath || ''));
  return normalized.includes(GUARDED_DIR) && normalized.endsWith('.json');
}

/**
 * Every slug a job can still serve: active master slug, active per-locale
 * slugs, flat `previousSlugs`, and every `previousSlugsByLocale` bucket.
 *
 * @param {object} job
 * @returns {Map<string, string|null>} slug → locale it is attributed to
 *          (null = unattributed / flat legacy entry)
 */
export function reachableSlugs(job) {
  const out = new Map();
  const add = (slug, locale) => {
    const norm = normalize(slug);
    if (!norm) return;
    // First attribution wins, but a real locale always beats `null`.
    if (!out.has(norm) || (out.get(norm) === null && locale !== null)) out.set(norm, locale);
  };

  add(job?.slug, 'it'); // master slug serves the IT path
  if (job?.slugByLocale && typeof job.slugByLocale === 'object') {
    for (const locale of LOCALES) add(job.slugByLocale[locale], locale);
  }
  if (job?.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object') {
    for (const locale of LOCALES) {
      const arr = job.previousSlugsByLocale[locale];
      if (Array.isArray(arr)) for (const s of arr) add(s, locale);
    }
  }
  if (Array.isArray(job?.previousSlugs)) for (const s of job.previousSlugs) add(s, null);

  return out;
}

/** The bucket `locale` occupied in the PREVIOUS on-disk version of a job. */
function priorBucket(beforeJob, locale) {
  const arr = locale === null
    ? beforeJob?.previousSlugs
    : beforeJob?.previousSlugsByLocale?.[locale];
  const out = [];
  if (Array.isArray(arr)) for (const s of arr) { const n = normalize(s); if (n) out.push(n); }
  return out;
}

/**
 * Bank `slug` — a slug with PROVEN history, i.e. one the on-disk version could
 * already serve — into `bucket`, without letting the cap swallow it.
 *
 * Why this is not a plain `capSlugArray([slug, ...bucket], cap)` (issue #5229):
 * `capSlugArray` keeps the NEWEST `cap` entries, and a rescued slug is inserted
 * at the OLDEST position, so it was always the first entry evicted. Whenever
 * the destination bucket came out of the write at/over cap, the guard was a
 * guaranteed no-op that reported the benign-looking 'cap-trim' outcome — the
 * silent loss it exists to prevent, wearing the name of the one eviction that
 * is legitimate.
 *
 * The cap is only a real explanation when the bucket was ALREADY full BEFORE
 * the write: that is routine LRU eviction, and it is exactly the condition
 * `scan-prev-slug-losses.mjs`'s `classifyCapTrim()` requires before it excuses
 * a disappearance. When instead the WRITE itself filled the bucket by adding
 * entries, the pressure is the writer's, and a slug that was already serving
 * outranks one that has never been published: make room by dropping the
 * newest entry this write introduced. Guard and tripwire then agree about what
 * counts as a loss, which is the property this module claims to have.
 *
 * @returns {{ next: string[], outcome: 'present'|'restored'|'cap-trim' }}
 */
function bankPreservingHistory(slug, bucket, prior, cap) {
  if (bucket.includes(slug)) return { next: bucket, outcome: 'present' };
  // Oldest-first position: a rescued slug is older than whatever is banked.
  if (bucket.length < cap) return { next: [slug, ...bucket], outcome: 'restored' };

  // The bucket was ALREADY at cap before this write: the eviction is the
  // documented LRU rotation, `classifyCapTrim()` excuses it, and fighting it
  // here would freeze the bucket forever — no genuine rename could ever be
  // captured again once a job's history filled up. Concede, but journal.
  if (prior.length >= cap) return { next: bucket, outcome: 'cap-trim' };

  // The WRITE created the pressure. Make room by dropping the newest entry it
  // introduced: a slug that has never been published loses to one that was
  // already serving.
  const priorSet = new Set(prior);
  for (let i = bucket.length - 1; i >= 0; i--) {
    if (priorSet.has(bucket[i])) continue; // proven history — never sacrificed
    const next = bucket.slice();
    next.splice(i, 1);
    return { next: [slug, ...next], outcome: 'restored' };
  }
  return { next: bucket, outcome: 'cap-trim' };
}

/**
 * Re-capture `slug` into `job`'s history under `locale`.
 *
 * Returns 'restored' when the slug survives the write, 'cap-trim' when the
 * destination bucket was already legitimately full BEFORE this write
 * (documented LRU eviction — the scanner classifies this as not-a-loss), or
 * 'present' when already there.
 */
function recapture(job, slug, locale, beforeJob) {
  const norm = normalize(slug);
  if (!norm) return 'present';

  if (locale === null) {
    // Unattributed legacy entry → flat array only.
    if (!Array.isArray(job.previousSlugs)) job.previousSlugs = [];
    const { next, outcome } = bankPreservingHistory(
      norm, job.previousSlugs, priorBucket(beforeJob, null), GUARD_LEGACY_CAP,
    );
    job.previousSlugs = next;
    if (outcome === 'cap-trim') {
      recordSlugMutation({
        jobId: job.id || '<unkeyed>', locale: null, slug: norm, action: 'cap-trim',
        source: 'slug-preservation-guard/flat',
        reason: `bucket-full-before-write cap=${GUARD_LEGACY_CAP}`,
      });
    }
    return outcome;
  }

  if (!job.previousSlugsByLocale || typeof job.previousSlugsByLocale !== 'object') {
    job.previousSlugsByLocale = {};
  }
  const bucket = Array.isArray(job.previousSlugsByLocale[locale])
    ? job.previousSlugsByLocale[locale]
    : [];
  const banked = bankPreservingHistory(
    norm, bucket, priorBucket(beforeJob, locale), GUARD_PER_LOCALE_CAP,
  );
  job.previousSlugsByLocale[locale] = banked.next;

  if (banked.outcome === 'cap-trim') {
    recordSlugMutation({
      jobId: job.id || '<unkeyed>', locale, slug: norm, action: 'cap-trim',
      source: 'slug-preservation-guard',
      reason: `bucket-full-before-write cap=${GUARD_PER_LOCALE_CAP}`,
    });
    return 'cap-trim';
  }
  if (banked.outcome === 'present') return 'present';

  // Keep the flat legacy mirror in sync so consumers that never migrated to
  // previousSlugsByLocale still emit the redirect.
  if (!Array.isArray(job.previousSlugs)) job.previousSlugs = [];
  const mirrored = bankPreservingHistory(
    norm, job.previousSlugs, priorBucket(beforeJob, null), GUARD_LEGACY_CAP,
  );
  job.previousSlugs = mirrored.next;
  return 'restored';
}

/**
 * Diff `nextValue` against the slice currently on disk and re-capture every
 * slug that would otherwise disappear. Mutates `nextValue` in place.
 *
 * Pure-ish and directly unit-testable: pass `previousValue` to skip the read.
 *
 * @param {string} filePath        destination slice path
 * @param {any}    nextValue       payload about to be written
 * @param {object} [opts]
 * @param {any}    [opts.previousValue] pre-loaded previous slice (test seam)
 * @param {Set<string>} [opts.denylist] pre-loaded denylist (test seam)
 * @param {string} [opts.root]     repository root (for the denylist lookup)
 * @returns {{ restored: number, capTrimmed: number, jobsTouched: number, slugs: string[] }}
 */
export function preserveSlugHistory(filePath, nextValue, opts = {}) {
  const empty = { restored: 0, capTrimmed: 0, jobsTouched: 0, slugs: [] };

  if (String(process.env.SLUG_PRESERVATION_GUARD || '').toLowerCase() === 'off') return empty;
  if (!isGuardedSlicePath(filePath)) return empty;
  if (!nextValue || !Array.isArray(nextValue.jobs) || nextValue.jobs.length === 0) return empty;

  let previous = opts.previousValue;
  if (previous === undefined) {
    try {
      previous = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return empty; // first write of this slice — nothing to preserve
    }
  }
  if (!previous || !Array.isArray(previous.jobs) || previous.jobs.length === 0) return empty;

  const base = path.basename(filePath);
  const root = opts.root ?? path.resolve(path.dirname(filePath), '..', '..', '..');
  const denylist = opts.denylist ?? loadGuardDenylist(root);

  const previousByKey = new Map();
  for (const job of previous.jobs) {
    const key = resolveJobDiffKey(job);
    if (key && !previousByKey.has(key)) previousByKey.set(key, job);
  }

  let restored = 0;
  let capTrimmed = 0;
  const touched = new Set();
  const restoredSlugs = [];

  for (const job of nextValue.jobs) {
    const key = resolveJobDiffKey(job);
    if (!key) continue;
    const before = previousByKey.get(key);
    if (!before) continue; // brand-new job — no history to lose

    const beforeSlugs = reachableSlugs(before);
    if (beforeSlugs.size === 0) continue;
    const afterSlugs = reachableSlugs(job);

    for (const [slug, locale] of beforeSlugs) {
      if (afterSlugs.has(slug)) continue;
      if (denylist.has(denylistKey(base, slug))) continue; // removed on purpose

      const outcome = recapture(job, slug, locale, before);
      if (outcome === 'restored') {
        restored++;
        touched.add(key);
        restoredSlugs.push(slug);
        recordSlugMutation({
          jobId: job.id || key,
          locale,
          slug,
          action: 'restore',
          source: 'slug-preservation-guard',
          reason: `would-have-been-dropped-by-write:${base}`,
        });
      } else if (outcome === 'cap-trim') {
        capTrimmed++;
      }
    }
  }

  return { restored, capTrimmed, jobsTouched: touched.size, slugs: restoredSlugs };
}
