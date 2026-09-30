/**
 * Remove, from STORED jobs, a description a crawler once wrote itself: an
 * intro or footer wrapped around the source text ("Stelle: <titolo>.",
 * "Karriereseite: …", a company paragraph), or a whole description made of
 * listing metadata when the detail was not read.
 *
 * A crawler now publishes only the source text. But the locale-preserving
 * merge keeps every non-source translation of a job whose source did not
 * drift much, and keeps the stored source slot when the fresh one is empty,
 * so without this the invented text — and the translations made from it —
 * would outlive the fix. A crawler calls it on its stored jobs before the
 * merge (`prepareExistingJobs` on the standard pipeline, its own merge
 * otherwise); the localization step then translates the real posting.
 */
import {
  dropFabricatedLocaleText,
  dropTranslationsOfFabricatedSource,
} from './source-locale-description.mjs';

/**
 * Drop the fabricated description of one stored job: the translations made
 * from it, the source slot and the flat `description`. `pattern` matches a
 * fragment only the crawler ever wrote.
 *
 * @param {object} job
 * @param {RegExp} pattern
 * @param {{ strip?: (text: string) => string }} [options]
 * @returns {boolean} true when the job carried the crawler's text.
 */
export function dropFabricatedDescription(job, pattern, options = {}) {
  if (!job || typeof job !== 'object') return false;
  const strip = typeof options?.strip === 'function' ? options.strip : null;

  // The historical callers without a strip function intentionally keep the
  // old all-or-nothing behaviour: their pattern identifies a whole stored
  // description, not a fragment mixed with source text.
  if (!strip) {
    const derived = dropTranslationsOfFabricatedSource(job, pattern);
    let slots = false;
    for (const locale of Object.keys(job.descriptionByLocale || {})) {
      if (dropFabricatedLocaleText(job, locale, pattern)) slots = true;
    }
    const flat = pattern.test(String(job.description || ''));
    if (flat) {
      job.description = '';
      job.needsRetranslation = true;
    }
    return derived || slots || flat;
  }

  const byLocale = job.descriptionByLocale && typeof job.descriptionByLocale === 'object'
    ? job.descriptionByLocale
    : null;
  const sourceLang = String(job.sourceLang || '').trim();
  const source = String((sourceLang && byLocale?.[sourceLang]) || job.description || '');
  const flat = String(job.description || '');
  const sourceMatches = pattern.test(source);
  const flatMatches = pattern.test(flat);
  const sourceWasFabricated = sourceMatches || flatMatches;
  let changed = false;

  if (sourceWasFabricated) {
    // Every localized slot was translated from the dirty source and must go,
    // even when its translated or markdown-wrapped wording no longer matches
    // the source regex. When only the flat field proves the old shape, it is
    // the authoritative body to clean and to put back in sourceLang.
    const sourceToClean = sourceMatches ? source : flat;
    const cleaned = String(strip(sourceToClean) ?? '');
    if (byLocale) {
      for (const locale of Object.keys(byLocale)) {
        if (locale !== sourceLang) {
          delete byLocale[locale];
          changed = true;
        }
      }
      if (sourceLang) {
        if (cleaned) byLocale[sourceLang] = cleaned;
        else delete byLocale[sourceLang];
        changed = true;
      }
    }
    if (flatMatches) job.description = String(strip(flat) ?? '');
    job.needsRetranslation = true;
    changed = true;
  }

  let slots = false;
  for (const locale of Object.keys(job.descriptionByLocale || {})) {
    // The source slot was cleaned above instead of being discarded.
    if (sourceWasFabricated && locale === sourceLang) continue;
    if (dropFabricatedLocaleText(job, locale, pattern)) slots = true;
  }

  return changed || slots;
}

/**
 * `dropFabricatedDescription` over a crawler's stored jobs, with one log line
 * when anything was removed. Returns the same array, so it can be passed
 * as `prepareExistingJobs`.
 *
 * @param {object[]} jobs
 * @param {RegExp} pattern
 * @param {string} label
 * @param {{ strip?: (text: string) => string }} [options]
 * @returns {object[]}
 */
export function dropFabricatedDescriptions(jobs, pattern, label, options = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const repaired = list.filter((job) => dropFabricatedDescription(job, pattern, options)).length;
  if (repaired > 0) {
    console.log(`  🧹 ${label}: removed the crawler-written description from ${repaired} stored job(s); they will be retranslated`);
  }
  return list;
}
