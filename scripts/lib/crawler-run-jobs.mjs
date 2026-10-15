import fs from 'node:fs';

/**
 * Read the jobs the CURRENT run has merged, from its own scratch working set.
 *
 * The counterpart of `readExistingCrawlerJobs()` (assemble-jobs-dataset.mjs),
 * and deliberately not a variant of it. That helper answers "what is published
 * today?": it prefers the on-disk `data/jobs/by-crawler/<key>.json` slice of
 * the PREVIOUS run whenever that slice is non-empty, and only falls back to the
 * scratch path when it is empty or absent. That is the right answer BEFORE
 * `mergeJobs()` — it is where the prior identities and the before-snapshot come
 * from — and the wrong one after it.
 *
 * Every post-merge step that re-read through it (locale repair, slug refresh,
 * description alignment) got the previous run's jobs back and then wrote them
 * over the working set, silently discarding what the run had just merged.
 *
 * Observed on Artisa's proven-empty branch (issue #7706, item 3): the careers
 * page proved zero vacancies, `mergeJobs([])` emptied the scratch file, and the
 * locale repair resurrected the three retired jobs from the published slice.
 * They were archived as expired AND republished as active, and the summary went
 * out with `total: 3` next to `authoritativeEmptySnapshot: true` — a
 * combination `nextCrawlerState()` (check-crawler-health.mjs) reads as "proof
 * present but jobCount > 0" and therefore drops, so the per-run evidence #7537
 * added to that runner never reached the monitor.
 *
 * No fallback to the published slice, by design: an absent scratch file means
 * this run has merged nothing, and the honest working set for that is empty.
 * Every caller runs after a `mergeJobs()` that writes the scratch file
 * unconditionally.
 *
 * Kept dependency-free (node:fs only), like `crawler-scratch-path.mjs`, so the
 * dedicated runners can import it without pulling in the assembly module.
 *
 * @param {string} dataJobsPath — the per-crawler scratch path
 *   (`crawlerScratchPathFor(companyKey)`).
 * @returns {object[]}
 */
export function readCurrentRunJobs(dataJobsPath) {
  if (!dataJobsPath || !fs.existsSync(dataJobsPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(dataJobsPath, 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
