/**
 * scripts/lib/slug-history-journal.mjs
 *
 * In-memory append-only log of every previousSlugs / previousSlugsByLocale
 * mutation during a single crawler run.
 *
 * Why this exists: when a crawl drops or rewrites a slug we lose the SEO
 * bridge. To debug WHICH function changed WHICH slug we tag every mutation
 * with a source string, then expose a one-shot summary at process exit
 * that the commit script appends to the commit message body.
 *
 * Surface:
 *   recordSlugMutation({ jobId, locale, slug, action, source, reason? })
 *   summarize()      → { total, captured, dropped, restored, capTrimmed, sources, jobs }
 *   formatSummary()  → human-readable string for commit message body
 *   writeSummaryOnExit(path?) → registers process.on('exit') hook
 *   clear()          → reset (for tests)
 *
 * Storage: zero on-disk footprint by default. The summary is written to a
 * temp file (default: $SLUG_HISTORY_SUMMARY_FILE or
 * /tmp/slug-history-summary-$$.txt) and consumed by git-commit-data.sh.
 * The file is single-use and unlinked after read by the commit script.
 */
import fs from 'node:fs';
import { diffLocaleKeys } from './locale-map-diff.mjs';

/**
 * How many event objects stay in memory. The journal used to retain EVERY
 * event for the whole process, but the only bulk consumer is `summarize()`,
 * which needs counters and not the objects: measured on a 5000-job slice with
 * all four locales restored, `restoreExistingSlugIdentity` pushed 25 000
 * events (~5.6 MB retained) to render a 116-char summary, and
 * `assemble-jobs-dataset.mjs` walks every crawler slice inside ONE process, so
 * that cost is paid once per slice and never released (follow-up #7633). The
 * counters are now folded in at record time, so they stay EXACT for the whole
 * run regardless of retention; only the tail kept for debugging is bounded.
 * `SLUG_JOURNAL_MAX_EVENTS` raises/lowers it when a run needs a deeper trace.
 */
export const RETAINED_EVENTS_CAP = (() => {
  const raw = Number(process.env.SLUG_JOURNAL_MAX_EVENTS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2000;
})();

/**
 * Circular buffer of the newest `RETAINED_EVENTS_CAP` events. A ring (rather
 * than `push` + `shift`) keeps recording O(1) on the hot path of a full
 * corpus pass.
 * @type {Array<{ts:number,jobId:string,locale:string|null,slug:string,action:string,source:string,reason?:string}>}
 */
const _events = [];
let _writeIdx = 0;
let _wrapped = false;

/** Running aggregates — independent of retention, never truncated. */
const _byAction = { capture: 0, drop: 0, restore: 0, 'cap-trim': 0, sync: 0 };
const _bySource = new Map();
const _jobs = new Set();
let _total = 0;

let _exitHookRegistered = false;

const VALID_ACTIONS = new Set(['capture', 'drop', 'cap-trim', 'restore', 'sync']);

/**
 * Record a single slug mutation. Best-effort: missing/invalid input is
 * dropped silently to avoid breaking the crawl on instrumentation bugs.
 */
export function recordSlugMutation({ jobId, locale, slug, action, source, reason } = {}) {
  if (!jobId || !slug || !action || !source) return;
  if (!VALID_ACTIONS.has(action)) return;
  const id = String(jobId);
  const src = String(source);

  _total++;
  _byAction[action] = (_byAction[action] || 0) + 1;
  _bySource.set(src, (_bySource.get(src) || 0) + 1);
  _jobs.add(id);

  const event = {
    ts: Date.now(),
    jobId: id,
    locale: locale ? String(locale) : null,
    slug: String(slug),
    action,
    source: src,
    reason: reason ? String(reason) : undefined,
  };
  _events[_writeIdx] = event;
  _writeIdx = (_writeIdx + 1) % RETAINED_EVENTS_CAP;
  if (_writeIdx === 0) _wrapped = true;
}

/**
 * Get a defensive copy of the retained events, oldest-first. Bounded by
 * `RETAINED_EVENTS_CAP`: on a run that exceeds it this is the newest slice of
 * the trace, not the whole history — `summarize()` stays exact either way.
 */
export function getEvents() {
  if (!_wrapped) return _events.slice(0, _writeIdx);
  return [..._events.slice(_writeIdx), ..._events.slice(0, _writeIdx)];
}

/**
 * Cap an already-deduplicated slug array, keeping the NEWEST `cap` entries
 * and journaling any overflow as a 'cap-trim' mutation instead of silently
 * dropping it. This is the single shared primitive every previousSlugs cap
 * site must delegate to (issue #3377: every one of the ~6 independent
 * `.slice(0, cap)` call sites across the codebase — including the original
 * `mergePreviousSlugsCapped` below — kept the OLDEST `cap` entries instead
 * of the newest. Once a job's accumulated slug history exceeded `cap`
 * (default 20), every subsequent capture silently discarded the NEWEST
 * slug instead of the oldest: an inverted LRU. Low-churn jobs never notice;
 * high-churn jobs (frequent title/translation regen) cross the threshold
 * and start losing freshly-captured slugs, which is exactly the "4193
 * losses in 24h" spike the issue reported — many jobs crossing the
 * 20-entry mark around the same time due to ongoing churn). Single shared
 * implementation so the direction can't drift back out of sync per-site.
 */
export function capSlugArray(union, cap, { jobId, locale = null, source } = {}) {
  const list = Array.isArray(union) ? union : [];
  const capped = list.length > cap ? list.slice(-cap) : list;
  if (list.length > capped.length) {
    recordSlugMutation({
      jobId, locale, slug: '<oldest>', action: 'cap-trim',
      source, reason: `cap=${cap}, trimmed=${list.length - capped.length}`,
    });
  }
  return capped;
}

/**
 * Union two previousSlugs arrays and cap the result, journaling any overflow
 * as a 'cap-trim' mutation instead of silently dropping it (issue class
 * #3284/#3313/#3314: bare `.slice(0, cap)` calls scattered across
 * company-specific crawler scripts each independently re-implemented this
 * union+trim with no journal, so history losses beyond the cap went
 * unrecorded per-script). Single shared implementation so the pattern can't
 * drift back into copy-pasted per-file trims.
 */
export function mergePreviousSlugsCapped(oldSlugs, newSlugs, { jobId, source, cap = 20 } = {}) {
  const union = [...new Set([...(Array.isArray(oldSlugs) ? oldSlugs : []), ...(Array.isArray(newSlugs) ? newSlugs : [])])];
  return capSlugArray(union, cap, { jobId, source });
}

/**
 * Restore the active slug identity of jobs already present in a crawler slice.
 *
 * This lives HERE, in the journal, and nowhere else (issue #6908). It is the
 * one operation that writes `slug` / `slugByLocale` / `previousSlugs` /
 * `previousSlugsByLocale` *backwards* — from the previous on-disk version onto
 * the freshly parsed one — so it is the exact shape of write the #5157
 * encapsulation invariant exists to contain. As a copy inside
 * `scripts/lib/crawler-template.mjs` it was six unjournaled direct writes
 * pinned in `tests/slug-write-encapsulation.test.ts`; as a journal primitive
 * every restore is recorded with `action: 'restore'` and the ratchet no longer
 * has to carry the debt. `crawler-template.mjs` re-exports this symbol, so all
 * callers reach the same implementation and a second copy cannot appear
 * without the ratchet noticing.
 *
 * Semantics (unchanged from the crawler-template original): this is
 * intentionally opt-in. Most crawlers should let a material title/location
 * correction mint a new slug and retain the old one as a redirect. A crawler
 * uses this stricter policy when the corrected field is display metadata and
 * changing an already-published URL would be needless.
 *
 * Matching is by the stable job ID that `mergePreserveLocaleData` has already
 * carried forward, and is fail-closed on duplicate IDs. Fresh jobs are
 * untouched. Existing history is restored verbatim so an intermediate
 * hardening pass cannot turn a transient derived slug into a permanent
 * redirect.
 *
 * @param {object[]} existingJobs
 * @param {object[]} currentJobs
 * @param {{ source?: string }} [options] journal attribution for the mutations
 * @returns {{ jobs: object[], restored: number }}
 */
export function restoreExistingSlugIdentity(existingJobs = [], currentJobs = [], { source = 'restoreExistingSlugIdentity' } = {}) {
  const counts = new Map();
  for (const job of existingJobs) {
    const id = String(job?.id || '').trim();
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const existingById = new Map();
  for (const job of existingJobs) {
    const id = String(job?.id || '').trim();
    if (id && counts.get(id) === 1) existingById.set(id, job);
  }

  let restored = 0;
  const jobs = currentJobs.map((job) => {
    const id = String(job?.id || '').trim();
    const old = id ? existingById.get(id) : null;
    if (!old) return job;

    const next = { ...job };
    const oldSlug = String(old.slug || '').trim();
    if (oldSlug && oldSlug !== String(next.slug || '').trim()) {
      next.slug = oldSlug;
      restored++;
      recordSlugMutation({
        jobId: id, locale: null, slug: oldSlug, action: 'restore', source,
        reason: `active slug reverted to the published value (was ${String(job.slug || '') || '<empty>'})`,
      });
    }
    if (old.slugByLocale && typeof old.slugByLocale === 'object') {
      const currentByLocale = next.slugByLocale && typeof next.slugByLocale === 'object'
        ? next.slugByLocale
        : {};
      const restoredByLocale = { ...old.slugByLocale };
      for (const [locale, slug] of Object.entries(currentByLocale)) {
        if (!(locale in restoredByLocale)) restoredByLocale[locale] = slug;
      }
      // Counter and journal must come from ONE comparison. `JSON.stringify(a)
      // !== JSON.stringify(b)` is key-order sensitive, so a map rebuilt as
      // `{ ...old }` + the current-only keys could serialise differently while
      // holding the identical pairs: `restored` incremented and the per-locale
      // loop below, which compares field by field, recorded nothing — the two
      // telling contradictory stories about the same restore (follow-up #7492).
      const changedLocales = diffLocaleKeys(restoredByLocale, currentByLocale);
      if (changedLocales.length > 0) {
        restored++;
        for (const locale of changedLocales) {
          recordSlugMutation({
            jobId: id, locale, slug: restoredByLocale[locale], action: 'restore', source,
            reason: `per-locale slug reverted to the published value (was ${String(currentByLocale[locale] || '') || '<absent>'})`,
          });
        }
      }
      next.slugByLocale = restoredByLocale;
    }

    if (Array.isArray(old.previousSlugs)) next.previousSlugs = [...old.previousSlugs];
    else delete next.previousSlugs;
    if (old.previousSlugsByLocale && typeof old.previousSlugsByLocale === 'object') {
      next.previousSlugsByLocale = Object.fromEntries(
        Object.entries(old.previousSlugsByLocale).map(([locale, slugs]) => [
          locale,
          Array.isArray(slugs) ? [...slugs] : slugs,
        ]),
      );
    } else {
      delete next.previousSlugsByLocale;
    }
    return next;
  });

  return { jobs, restored };
}

/** Reset the journal. Tests only. */
export function clear() {
  _events.length = 0;
  _writeIdx = 0;
  _wrapped = false;
  for (const key of Object.keys(_byAction)) _byAction[key] = 0;
  _bySource.clear();
  _jobs.clear();
  _total = 0;
}

/**
 * Read the aggregate counts per action, per source, per job.
 *
 * Folded in at record time rather than recomputed from the retained events:
 * the retained tail is capped (`RETAINED_EVENTS_CAP`), so recounting it would
 * make the commit-message numbers silently under-report the moment a run
 * crossed the cap — the counters must describe the RUN, not the buffer.
 */
export function summarize() {
  return {
    total: _total,
    captured: _byAction.capture,
    dropped: _byAction.drop,
    restored: _byAction.restore,
    capTrimmed: _byAction['cap-trim'],
    synced: _byAction.sync,
    sources: [..._bySource.entries()].sort((a, b) => b[1] - a[1]),
    jobsAffected: _jobs.size,
    net: _byAction.capture + _byAction.restore - _byAction.drop - _byAction['cap-trim'],
    retained: _wrapped ? RETAINED_EVENTS_CAP : _writeIdx,
    truncated: Math.max(0, _total - (_wrapped ? RETAINED_EVENTS_CAP : _writeIdx)),
  };
}

/**
 * Render the summary as commit-message body lines.
 * Returns '' when nothing happened (caller may skip the section entirely).
 */
export function formatSummary() {
  const s = summarize();
  if (s.total === 0) return '';
  const lines = [];
  lines.push('📜 previousSlugs delta:');
  const action = (k, n) => n > 0 ? `${k}: ${n}` : null;
  const head = [
    action('capture', s.captured),
    action('drop', s.dropped),
    action('restore', s.restored),
    action('cap-trim', s.capTrimmed),
  ].filter(Boolean).join(', ');
  lines.push(`  ${head || 'no net change'}`);
  // Top-3 sources by event count (full attribution map would bloat the commit).
  if (s.sources.length > 0) {
    const top = s.sources.slice(0, 4).map(([src, n]) => `${src}:${n}`).join(', ');
    lines.push(`  sources: ${top}${s.sources.length > 4 ? ` (+${s.sources.length - 4} more)` : ''}`);
  }
  lines.push(`  net: ${s.net >= 0 ? '+' : ''}${s.net} across ${s.jobsAffected} jobs`);
  return lines.join('\n');
}

/**
 * Default summary file location. Stable per process so the commit script
 * can find it without env coupling.
 */
export function defaultSummaryPath() {
  return process.env.SLUG_HISTORY_SUMMARY_FILE
    || `/tmp/slug-history-summary-${process.pid}.txt`;
}

/**
 * Register a process-exit hook that writes the summary to the temp file.
 * Idempotent. Skips writing if zero events were recorded.
 */
export function writeSummaryOnExit(path = defaultSummaryPath()) {
  if (_exitHookRegistered) return;
  _exitHookRegistered = true;
  process.on('exit', () => {
    const body = formatSummary();
    if (!body) return;
    try {
      fs.writeFileSync(path, body + '\n', 'utf8');
    } catch {
      /* best-effort; never fail the crawler on telemetry write */
    }
  });
}

// Auto-register the exit hook on first import so every crawler picks this up
// without per-script changes. Safe: writes only when there are events.
writeSummaryOnExit();
