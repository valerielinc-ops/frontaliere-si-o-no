/**
 * Drop true double publications from one crawler's fresh fetch: the same
 * advertisement reachable under two source ids. Publishing both produced two
 * indistinguishable job pages, which the parser-quality audit reports as
 * `duplicate-descriptions` (issue 5253). The identity always comes from the
 * source, never from empty fields; two ways to prove it:
 *
 * - `dropSameSourceReference`: the source gives both postings the same
 *   reference (Hirslanden prints the same Referenznummer on two SuccessFactors
 *   job ids; Lonza's same requisition id under two URLs).
 * - `dropIdenticalPostings`: identical title (up to the gender marker),
 *   identical and fully resolved workplace (locality, postal code and street
 *   all present) and an identical FULL description, compared case- and
 *   whitespace-insensitively (Stadt Zürich re-posts an ad under a second
 *   Referenz-Nr.; Otis prints the branch address in the ad).
 * - `identicalAdvertisementKey` + `keepLowestStableIdPerKey`: the same test
 *   on the source fields a crawler names as the workplace (Lonza: the Workday
 *   locations and time type of a second req carrying the same posting).
 *
 * Postings that differ anywhere in the text — a shift, a role name, a language
 * version — or in the workplace — Denner advertises the same store role for
 * two Zürich stores, postal codes 8048 and 8050 — are distinct vacancies and
 * are kept, even when the audit's
 * 500-character fingerprint window cannot tell them apart. Lines made only of
 * hashtags ("#ebkampagne #pflege", "#LI-DNI") are recruiting-campaign tracking
 * tags, not vacancy text, and are ignored in the comparison.
 *
 * Within a group the posting with the lowest stable source id is kept, so the
 * choice does not flip between runs while both stay online.
 */
import { extractStableJobId } from './job-match-key.mjs';

function normalized(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Gender markers are a spelling of the title, not a different role: Lonza
// published R76163-1 "Biotechnologist 100% (m/f/d)" and R76165-1
// "Biotechnologist 100% (m/w/d)" with the same text in Visp (2026-09-29).
const GENDER_MARKER_RE = /\(\s*(?:[mwfdxa](?:\s*[/|,]\s*[mwfdxa]){1,3}|a|all genders)\s*\)/giu;

function normalizedTitle(value) {
  return normalized(String(value || '').replace(GENDER_MARKER_RE, ' '));
}

function jobBody(job) {
  const text = job?.descriptionByLocale?.[job?.sourceLang] || job?.description || '';
  return String(text)
    .split('\n')
    .filter((line) => !/^\s*#[\p{L}\p{N}_-]+(?:\s+#[\p{L}\p{N}_-]+)*\s*$/u.test(line))
    .join('\n');
}

/**
 * Grouping key of one advertisement: title (up to the gender marker), the
 * workplace parts the caller names, and the full body. Empty — the posting is
 * never grouped — when the body is empty or any workplace part is missing:
 * an empty value never proves two postings identical.
 *
 * @param {object} job
 * @param {unknown[]} workplace  source fields that locate the vacancy
 * @returns {string}
 */
export function identicalAdvertisementKey(job, workplace = []) {
  const body = normalized(jobBody(job));
  if (!body) return '';
  const place = workplace.map(normalized);
  if (place.length === 0 || place.some((part) => !part)) return '';
  return `${normalizedTitle(job?.title)}\u0000${place.join('\u0000')}\u0000${body}`;
}

/**
 * Grouping key of a posting: title, workplace and full body. Empty — the
 * posting is never grouped — when the body is empty or the workplace is not
 * fully resolved: an empty text, or a missing locality, postal code or
 * street, never proves two postings identical. Otis leaves the locality blank
 * when a req names none, and two stores in one town differ only by postal code
 * or street; comparing blanks would merge distinct vacancies.
 *
 * @param {object} job
 * @returns {string}
 */
export function identicalPostingKey(job) {
  return identicalAdvertisementKey(job, [job?.addressLocality || job?.location, job?.postalCode, job?.streetAddress]);
}

function stableOrderKey(job) {
  const id = extractStableJobId(job?.url || '') || String(job?.url || '');
  const numeric = /^num:(\d+)$/.exec(id);
  return numeric ? { num: Number(numeric[1]), id } : { num: Number.POSITIVE_INFINITY, id };
}

function isLowerStableId(a, b) {
  const ka = stableOrderKey(a);
  const kb = stableOrderKey(b);
  if (ka.num !== kb.num) return ka.num < kb.num;
  return ka.id.localeCompare(kb.id, 'en', { numeric: true }) < 0;
}

/**
 * Keep one posting per non-empty key (the one with the lowest stable id),
 * preserving the order of the input. A posting whose key is empty is kept.
 *
 * @template T
 * @param {T[]} jobs
 * @param {(job: T) => string} keyOf
 * @returns {{ jobs: T[], dropped: T[] }}
 */
export function keepLowestStableIdPerKey(jobs, keyOf) {
  const keyByJob = new Map(jobs.map((job) => [job, keyOf(job)]));
  const keeperByKey = new Map();
  for (const job of jobs) {
    const key = keyByJob.get(job);
    if (!key) continue;
    const current = keeperByKey.get(key);
    if (!current || isLowerStableId(job, current)) keeperByKey.set(key, job);
  }
  const kept = [];
  const dropped = [];
  for (const job of jobs) {
    const key = keyByJob.get(job);
    if (!key || keeperByKey.get(key) === job) kept.push(job);
    else dropped.push(job);
  }
  return { jobs: kept, dropped };
}

/**
 * Keep one posting per double publication, preserving the order of the input.
 *
 * @template T
 * @param {T[]} jobs
 * @returns {{ jobs: T[], dropped: T[] }}
 */
export function dropIdenticalPostings(jobs = []) {
  return keepLowestStableIdPerKey(jobs, identicalPostingKey);
}

/**
 * Keep one posting per SOURCE reference, preserving the order of the input.
 *
 * `referenceOf(job)` returns the identifier the source itself gives the
 * advertisement (a reference number printed in the ad, a requisition id), or
 * '' when it gives none. Postings that carry the same reference are one
 * advertisement published under several URLs (Hirslanden: the same
 * Referenznummer under two SuccessFactors job ids); the one with the lowest
 * stable id is kept. A posting without a reference is never grouped: the
 * identity comes from the source, never from empty fields.
 *
 * @template T
 * @param {T[]} jobs
 * @param {(job: T) => string} referenceOf
 * @returns {{ jobs: T[], dropped: T[] }}
 */
export function dropSameSourceReference(jobs = [], referenceOf) {
  return keepLowestStableIdPerKey(jobs, (job) => String(referenceOf(job) || '').trim());
}
