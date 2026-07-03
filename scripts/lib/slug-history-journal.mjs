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

/** @type {Array<{ts:number,jobId:string,locale:string|null,slug:string,action:string,source:string,reason?:string}>} */
const _events = [];
let _exitHookRegistered = false;

const VALID_ACTIONS = new Set(['capture', 'drop', 'cap-trim', 'restore', 'sync']);

/**
 * Record a single slug mutation. Best-effort: missing/invalid input is
 * dropped silently to avoid breaking the crawl on instrumentation bugs.
 */
export function recordSlugMutation({ jobId, locale, slug, action, source, reason } = {}) {
  if (!jobId || !slug || !action || !source) return;
  if (!VALID_ACTIONS.has(action)) return;
  _events.push({
    ts: Date.now(),
    jobId: String(jobId),
    locale: locale ? String(locale) : null,
    slug: String(slug),
    action,
    source: String(source),
    reason: reason ? String(reason) : undefined,
  });
}

/** Get a defensive copy of all recorded events. */
export function getEvents() {
  return _events.slice();
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
  const capped = union.slice(0, cap);
  if (union.length > capped.length) {
    recordSlugMutation({
      jobId, locale: null, slug: '<oldest>', action: 'cap-trim',
      source, reason: `cap=${cap}, trimmed=${union.length - capped.length}`,
    });
  }
  return capped;
}

/** Reset the journal. Tests only. */
export function clear() {
  _events.length = 0;
}

/**
 * Compute aggregate counts per action, per source, per job.
 */
export function summarize() {
  const byAction = { capture: 0, drop: 0, restore: 0, 'cap-trim': 0, sync: 0 };
  const bySource = new Map();
  const jobs = new Set();
  for (const e of _events) {
    byAction[e.action] = (byAction[e.action] || 0) + 1;
    bySource.set(e.source, (bySource.get(e.source) || 0) + 1);
    jobs.add(e.jobId);
  }
  return {
    total: _events.length,
    captured: byAction.capture,
    dropped: byAction.drop,
    restored: byAction.restore,
    capTrimmed: byAction['cap-trim'],
    synced: byAction.sync,
    sources: [...bySource.entries()].sort((a, b) => b[1] - a[1]),
    jobsAffected: jobs.size,
    net: byAction.capture + byAction.restore - byAction.drop - byAction['cap-trim'],
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
