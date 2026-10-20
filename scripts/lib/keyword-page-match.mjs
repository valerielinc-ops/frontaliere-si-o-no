/**
 * keyword-page-match.mjs — the ONE answer to "which job ads does this keyword
 * landing list?" (#7915).
 *
 * The defect this module closes: a profession keyword page and the weekly
 * digest that decides whether to create it answered that question with two
 * different predicates. The digest counted ads with the multilingual alias
 * matcher of the taxonomy, the emitted page listed ads containing a single
 * Italian substring (`filterKeywords: [feedFilter]`).
 * `isPromotable` rejects a row when the two numbers diverge, so the gap was
 * manufactured by the generator, not by the market: `estetista` had 18 ads
 * («Kosmetikerin») and 0 literal matches, `agente-sicurezza` 36 ads and 493
 * literal matches for `sicurezza`.
 *
 * Consumers:
 *   - build-plugins/jobsSeoPagesPlugin.ts — `keywordPageMatcher(kwPage)` is
 *     the membership test of every keyword landing;
 *   - scripts/profession-keyword-opportunities.mjs — `professionPageIdForJob`
 *     supplies the per-job id for the one-pass `feedFilterJobCount` aggregate,
 *     i.e. the number of ads the Italian page will actually list.
 *
 * Pages opt in with `professionMatch: true` + `professionId` (written by
 * scripts/generate-keyword-pages-config.mjs for NEW profession-gap pages).
 * Every other page keeps the literal `filterKeywords` logic byte for byte, so
 * no already-indexed page changes its listing.
 *
 * Pure: no I/O. The only state is a WeakMap memo keyed by the job object, so
 * it is collected together with the jobs and never grows past them (the
 * jobs-seo-pages plugin has already OOMed at deploy time).
 */

import { matchProfessionTitle } from './profession-taxonomy.mjs';

/** job object -> (locale -> profession id | null). */
const professionMemo = new WeakMap();

/**
 * Profession of a job in ONE locale: its own translated title, falling back to
 * the source title. Never blended across the four locales (#4715): a
 * mistranslated title in one locale must not move the job into or out of
 * another locale's landing.
 */
function professionOfJob(job, locale) {
  const title = String(job?.titleByLocale?.[locale] || job?.title || '');
  if (!job || typeof job !== 'object') return matchProfessionTitle(title);
  let byLocale = professionMemo.get(job);
  if (!byLocale) {
    byLocale = new Map();
    professionMemo.set(job, byLocale);
  }
  if (byLocale.has(locale)) return byLocale.get(locale);
  const id = matchProfessionTitle(title);
  byLocale.set(locale, id);
  return id;
}

/** Profession id used by a profession keyword page for one job/locale. */
export function professionPageIdForJob(job, locale = 'it') {
  return professionOfJob(job, locale);
}

/**
 * Membership predicate of a keyword landing page.
 *
 * @param {{ professionMatch?: boolean, professionId?: string, filterKeywords?: string[] }} page
 * @returns {(job: any, locale: string) => boolean}
 */
export function keywordPageMatcher(page) {
  const professionId = typeof page?.professionId === 'string' ? page.professionId : '';
  if (page?.professionMatch === true && professionId) {
    return (job, locale) => professionPageIdForJob(job, locale) === professionId;
  }
  const words = Array.isArray(page?.filterKeywords) ? page.filterKeywords : [];
  if (words.length === 0) return () => false;
  // Literal logic, unchanged from the plugin's former inline `kwMatchesLocale`:
  // ALL filter keywords must appear in this locale's title/description (with
  // the source fields as fallback), company or location.
  return (job, locale) => {
    const haystack = [
      String(job?.titleByLocale?.[locale] || job?.title || ''),
      String(job?.descriptionByLocale?.[locale] || job?.description || ''),
      String(job?.company || ''), String(job?.location || ''),
    ].join(' ').toLowerCase();
    return words.every((kw) => haystack.includes(kw));
  };
}

/**
 * Number of ads a profession keyword page lists in `locale` — the single
 * definition the weekly digest gates promotion on.
 *
 * @param {any[]} jobs
 * @param {string} professionId
 * @param {string} [locale]
 */
export function countProfessionPageJobs(jobs, professionId, locale = 'it') {
  if (!Array.isArray(jobs) || typeof professionId !== 'string' || !professionId) return 0;
  const matches = keywordPageMatcher({ professionMatch: true, professionId });
  let n = 0;
  for (const job of jobs) if (matches(job, locale)) n++;
  return n;
}
