/**
 * Remove crawler-written description text from the jobs already stored in a
 * crawler slice (issue 5253).
 *
 * A parser that stops writing its own sentences (company blurbs, labelled
 * listing fields, summaries) fixes new records only. The locale-preserving
 * merge of `runStandardCrawlerPipeline` keeps every non-source translation
 * whose source text did not drift, so the translations of the old text would
 * outlive the fix. Runners call `repairStoredCrawlerSlice` before the
 * pipeline; the localization step then translates the posting's own text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write-json.mjs';

/**
 * Repair one stored job whose source text matches `pattern`: drop its
 * non-source translations, apply `strip` to the source slot and to
 * `description`, and flag it for retranslation. Returns true when the job
 * changed; a second call on the same job returns false.
 *
 * @param {object} job
 * @param {{ pattern: RegExp, strip?: (text: string) => string, defaultLang?: string }} options
 * @returns {boolean}
 */
export function dropFabricatedSourceText(job, { pattern, strip = (text) => text, defaultLang = 'de' }) {
  const byLocale = job?.descriptionByLocale && typeof job.descriptionByLocale === 'object'
    ? job.descriptionByLocale
    : null;
  const sourceLang = job?.sourceLang || defaultLang;
  const source = String((byLocale && byLocale[sourceLang]) || job?.description || '');
  if (!pattern.test(source)) return false;
  let changed = false;
  if (byLocale) {
    for (const locale of Object.keys(byLocale)) {
      if (locale === sourceLang) continue;
      delete byLocale[locale];
      changed = true;
    }
    if (typeof byLocale[sourceLang] === 'string') {
      const cleaned = strip(byLocale[sourceLang]);
      if (cleaned !== byLocale[sourceLang]) {
        byLocale[sourceLang] = cleaned;
        changed = true;
      }
    }
  }
  if (typeof job.description === 'string') {
    const cleaned = strip(job.description);
    if (cleaned !== job.description) {
      job.description = cleaned;
      changed = true;
    }
  }
  if (changed) job.needsRetranslation = true;
  return changed;
}

/**
 * Apply `repairJob` to every job of `data/jobs/by-crawler/<crawlerKey>.json`
 * and rewrite the slice when at least one job changed.
 *
 * @param {string} root repository root
 * @param {string} crawlerKey
 * @param {(job: object) => boolean} repairJob
 * @returns {number} jobs changed
 */
export function repairStoredCrawlerSlice(root, crawlerKey, repairJob) {
  const slicePath = path.join(root, 'data', 'jobs', 'by-crawler', `${crawlerKey}.json`);
  if (!fs.existsSync(slicePath)) return 0;
  const slice = JSON.parse(fs.readFileSync(slicePath, 'utf8'));
  const jobs = Array.isArray(slice) ? slice : (Array.isArray(slice?.jobs) ? slice.jobs : []);
  const repaired = jobs.filter((job) => repairJob(job)).length;
  if (repaired > 0) writeJsonAtomic(slicePath, slice);
  return repaired;
}
