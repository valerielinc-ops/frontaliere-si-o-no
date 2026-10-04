/**
 * crawler-retranslation-baseline — a crawler may raise `needsRetranslation`
 * only when the job's source text changed or its translations are incomplete.
 *
 * WHAT WAS MEASURED (2026-09-26, the 24 "Auto-update crawler group" commits
 * between 13:50Z and 15:19Z): 9.223 records went from unflagged to flagged,
 * and on 9.105 of them (98,7%) title, description and source language were
 * byte-identical after whitespace normalisation. On group 03 alone, 401 of the
 * 516 new flags were cleared by the next translate-pending run without a
 * single character of `titleByLocale`/`descriptionByLocale` changing.
 *
 * WHY. The flag has many writers on the crawler path — the localization step
 * with `SKIP_AI_TRANSLATION=1` (the dispatch default of every crawler group)
 * flags every job it force-localizes, `hardenJobLocaleFields` re-runs its
 * wrong-language detectors on stored slots, the slice writer's word-list
 * quality gate — and each re-judges translations that have not changed since
 * the last crawl accepted them. The consumer has ONE arbiter: translate-pending
 * (`reconcileRetranslationState` in relocalize-pending-jobs.mjs) clears the
 * flag from every slice record that passes `isIncomplete()` before it
 * translates anything. So a crawler flag on an unchanged, complete record is
 * erased one run later with no repair, re-raised on the next crawl, and in
 * between it sorts ahead of genuinely untranslated jobs in a queue drained
 * ~900 jobs per run.
 *
 * THE RULE, applied at the crawler slice boundary (writeJobsCrawlerSlice):
 * a flag is kept when the record was already flagged before this run, when it
 * is new, when its source text changed (normalised hash below), or when
 * `isIncomplete()` says there is translation work. It is dropped only when
 * none of these hold — i.e. exactly when translate-pending would clear it
 * unrepaired. A real source change keeps its flag even with complete-looking
 * translations (they translate the OLD text: measured case, a title that
 * became a different role while every locale still held the previous one).
 *
 * THE BASELINE is the slice as it stood when this process first read it —
 * the committed state of the previous run. It must be captured before
 * `seedCrawlerSlicesFromDataJobs` overwrites the slice with the merged
 * working set (after that, "previous" and "current" are the same text and
 * every source change would look unchanged). Both `readExistingCrawlerJobs`
 * (first read of every crawler runner) and the seed record it; first record
 * per key wins, later records are ignored by construction.
 *
 * Dependency-free (node:crypto only) so dedicated-crawler-common and the
 * assembler can both import it without an import cycle; the completeness
 * verdict is injected by the caller.
 */
import { createHash } from 'node:crypto';

/** @type {Map<string, Map<string, { flagged: boolean, hash: string }>>} */
const baselines = new Map();

function normalizeSourceText(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;| /gi, ' ')
    // Markdown/list scaffolding is formatting, not wording.
    .replace(/^[ \t]*(?:#{1,6}|[-*•·]|\d+[.)])[ \t]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Hash of the text a translation is made FROM: source language, title and
 * description, normalised so a whitespace / markup / case rewrite of the same
 * words hashes identically (the "formal only" class of change).
 */
export function retranslationSourceHash(job) {
  const sourceLang = String(job?.sourceLang || '').trim().toLowerCase();
  const title = job?.title || job?.titleByLocale?.[sourceLang] || '';
  const description = job?.description || job?.descriptionByLocale?.[sourceLang] || '';
  return createHash('sha256')
    .update(JSON.stringify([sourceLang, normalizeSourceText(title), normalizeSourceText(description)]))
    .digest('hex');
}

function identityKeys(job) {
  const keys = [];
  const id = String(job?.id || '').trim();
  const url = String(job?.url || '').trim();
  if (id) keys.push(`id:${id}`);
  if (url) keys.push(`url:${url}`);
  return keys;
}

/**
 * Project stored records to what the rule needs. A projection, not the
 * records: later pipeline steps mutate the objects they were read into.
 */
export function snapshotRetranslationBaseline(jobs) {
  const snapshot = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || typeof job !== 'object') continue;
    const entry = { flagged: job.needsRetranslation === true, hash: retranslationSourceHash(job) };
    for (const key of identityKeys(job)) {
      if (!snapshot.has(key)) snapshot.set(key, entry);
    }
  }
  return snapshot;
}

/**
 * Record the pre-run slice of `crawlerKey`. First call per key wins.
 * @returns {boolean} true when this call recorded the baseline
 */
export function recordRetranslationBaseline(crawlerKey, jobs) {
  const key = String(crawlerKey || '').trim();
  if (!key || baselines.has(key)) return false;
  baselines.set(key, snapshotRetranslationBaseline(jobs));
  return true;
}

export function getRetranslationBaseline(crawlerKey) {
  return baselines.get(String(crawlerKey || '').trim()) || null;
}

/** Test seam: the registry is process-wide by design. */
export function _resetRetranslationBaselines() {
  baselines.clear();
}

/**
 * Drop the `needsRetranslation` flags this run raised on records whose source
 * text is unchanged and whose translations are complete. Mutates `jobs`.
 *
 * @param {object[]} jobs
 * @param {Map|object[]|null} baseline  a snapshot, or the pre-run records
 * @param {{ isIncomplete: (job: object) => boolean }} deps
 */
export function dropSpuriousRetranslationFlags(jobs, baseline, { isIncomplete } = {}) {
  if (typeof isIncomplete !== 'function') {
    throw new TypeError('dropSpuriousRetranslationFlags: isIncomplete is required');
  }
  const snapshot = baseline instanceof Map ? baseline : snapshotRetranslationBaseline(baseline);
  const report = {
    flagged: 0,
    dropped: 0,
    keptNoBaseline: 0,
    keptAlreadyFlagged: 0,
    keptSourceChanged: 0,
    keptIncomplete: 0,
  };
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || job.needsRetranslation !== true) continue;
    report.flagged += 1;
    const previous = identityKeys(job).map((key) => snapshot.get(key)).find(Boolean);
    if (!previous) { report.keptNoBaseline += 1; continue; }
    if (previous.flagged) { report.keptAlreadyFlagged += 1; continue; }
    if (previous.hash !== retranslationSourceHash(job)) { report.keptSourceChanged += 1; continue; }
    if (isIncomplete(job)) { report.keptIncomplete += 1; continue; }
    delete job.needsRetranslation;
    report.dropped += 1;
  }
  return report;
}
