/**
 * Source-language relabel flag for crawlers merged by the frozen standard
 * pipeline (`runStandardCrawlerPipeline` → `mergePreserveLocaleData`).
 *
 * Issue 5253: several parsers derived `sourceLang` from the job TITLE, so
 * titles like "Candidatura spontanea" or "Junior Logistics Specialist" filed an
 * Italian body under `en`/`fr`/`de`. Deriving the language from the body fixes
 * the fresh record, but the stored record keeps the mislabeled copy in the old
 * source slot: `mergeLocaleTextMap` preserves every non-source slot, so the
 * old `en: <italian text>` would survive every crawl.
 *
 * The standard pipeline exposes no post-merge hook, but it keeps a fresh
 * `needsRetranslation`, and the localization step it runs in the same crawl
 * (`enrichJobLocalesDCC`) retranslates EVERY non-source slot of a job that
 * carries the flag. Flagging exactly the jobs whose language changed replaces
 * the stale copies without retranslating the whole slice on every run.
 */
import { extractStableJobId } from './job-match-key.mjs';

function relabelKey(job) {
  return extractStableJobId(job?.url) || String(job?.url || '').trim().toLowerCase();
}

/**
 * Mark the fresh jobs whose derived `sourceLang` differs from the stored one.
 * Mutates `freshJobs` in place (the pipeline keeps the array identity and any
 * `.discoveredCount` it carries) and returns how many jobs were flagged.
 *
 * @param {object[]} freshJobs     Jobs just built by the parser.
 * @param {object[]} existingJobs  Jobs currently stored in the crawler slice.
 * @returns {number}
 */
export function flagRelabeledSourceLang(freshJobs = [], existingJobs = []) {
  const storedLang = new Map();
  for (const job of Array.isArray(existingJobs) ? existingJobs : []) {
    const key = relabelKey(job);
    if (key && job?.sourceLang) storedLang.set(key, job.sourceLang);
  }
  let flagged = 0;
  for (const job of Array.isArray(freshJobs) ? freshJobs : []) {
    const previous = storedLang.get(relabelKey(job));
    if (previous && job?.sourceLang && previous !== job.sourceLang) {
      job.needsRetranslation = true;
      flagged += 1;
    }
  }
  return flagged;
}

async function defaultReadExisting() {
  const [{ readExistingCrawlerJobs }, { crawlerScratchPathFor }] = await Promise.all([
    import('../assemble-jobs-dataset.mjs'),
    import('./crawler-scratch-path.mjs'),
  ]);
  // Same source the standard pipeline merges against (its Step 1).
  return (companyKey) => readExistingCrawlerJobs(companyKey, crawlerScratchPathFor(companyKey));
}

/**
 * Wrap a standard-pipeline `fetchJobs` so the jobs it returns carry the
 * relabel flag. The result is returned unchanged (array or `{ jobs }`), and a
 * failure to read the stored slice never fails the crawl: without the stored
 * record there is nothing to relabel.
 *
 * @param {Function} fetchJobs
 * @param {string}   companyKey
 * @param {{ readExisting?: (companyKey: string) => object[] }} [opts]
 * @returns {Function}
 */
export function withSourceLangRelabelFlags(fetchJobs, companyKey, { readExisting } = {}) {
  return async (...args) => {
    const result = await fetchJobs(...args);
    const jobs = Array.isArray(result) ? result : result?.jobs;
    try {
      const read = readExisting || await defaultReadExisting();
      const flagged = flagRelabeledSourceLang(jobs, read(companyKey));
      if (flagged > 0) {
        console.log(`  🔁 ${companyKey}: ${flagged} job(s) with a re-derived source language — non-source locales will be retranslated`);
      }
    } catch (err) {
      console.warn(`  ⚠️ ${companyKey}: source-language relabel check skipped: ${err?.message || err}`);
    }
    return result;
  };
}
