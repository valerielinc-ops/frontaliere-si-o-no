/**
 * Drop true double publications from one crawler's fresh fetch.
 *
 * A double publication is the same advertisement reachable under two source
 * ids: identical title (up to the gender marker), identical and fully
 * resolved workplace (locality, postal code and street all present)
 * and an identical FULL description (compared case- and
 * whitespace-insensitively). Two such rows are one vacancy
 * to a reader; publishing both produced two indistinguishable job pages, which
 * the parser-quality audit reports as `duplicate-descriptions` (issue 5253:
 * Hirslanden re-posts a requisition under a second SuccessFactors job id with
 * the same Referenznummer; Lonza opens a second Workday req with the same ad).
 *
 * Postings that differ anywhere in the text — a shift, a role name, a language
 * version — or in the workplace — Denner advertises the same store role for
 * two Zürich stores, postal codes 8048 and 8050 — are distinct vacancies and
 * are kept, even when the audit's
 * 500-character fingerprint window cannot tell them apart. Lines made only of
 * hashtags ("#ebkampagne #pflege", "#LI-DNI") are recruiting-campaign tracking
 * tags, not vacancy text, and are ignored in the comparison: Hirslanden
 * re-posted Referenznummer 43018 with such a line appended.
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
  const body = normalized(jobBody(job));
  if (!body) return '';
  const place = [job?.addressLocality || job?.location, job?.postalCode, job?.streetAddress].map(normalized);
  if (place.some((part) => !part)) return '';
  return `${normalizedTitle(job?.title)}\u0000${place.join('\u0000')}\u0000${body}`;
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
 * Keep one posting per double publication, preserving the order of the input.
 *
 * @template T
 * @param {T[]} jobs
 * @returns {{ jobs: T[], dropped: T[] }}
 */
export function dropIdenticalPostings(jobs = []) {
  const keeperByKey = new Map();
  for (const job of jobs) {
    const key = identicalPostingKey(job);
    if (!key) continue;
    const current = keeperByKey.get(key);
    if (!current || isLowerStableId(job, current)) keeperByKey.set(key, job);
  }
  const kept = [];
  const dropped = [];
  for (const job of jobs) {
    const key = identicalPostingKey(job);
    if (!key || keeperByKey.get(key) === job) kept.push(job);
    else dropped.push(job);
  }
  return { jobs: kept, dropped };
}
