/**
 * Cross-crawler duplicate postings for the monolithic housekeeping pass
 * (`cleanup-jobs.mjs`, step 3).
 *
 * Two records are the same posting only when the source proves it:
 *   - same title, company, location, postal code AND street (a fully
 *     resolved workplace), or
 *   - same title, company and location under the same source identity (the stable id
 *     or normalized URL of `mergeUrlKey`: Bank Cler serves req 2740 under
 *     both `/jobs-und-karriere/` and `/jobs-und-karriere-2026/`).
 *
 * Title, company and locality alone are not a proof. The old key
 * `title|company|location` deleted distinct vacancies whose pages stay
 * online: Coop advertises "Verkäufer:in Food" for several Zürich stores
 * (different postal codes and streets), Rituals opens one Workday req per
 * vacancy at Carouge La Praille (R2402, R2403, R2404), Rolex and Liebherr
 * publish the same title under different requisition numbers. A record
 * without a postal code or street and without a shared source identity is
 * never removed here (same rule as `identicalPostingKey` in
 * `identical-posting-dedupe.mjs`).
 *
 * The newest `crawledAt` wins, as before.
 */
import { mergeUrlKey } from './job-url-key.mjs';

function normalized(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The `title|company|location` key the dedup proof sidecar carries
 * (`crawler-slice-integrity.mjs` recomputes it to validate each removal).
 * Every pair this module groups shares it.
 */
export function titleCompanyLocationKey(job) {
  return `${normalized(job?.title)}|${normalized(job?.company)}|${normalized(job?.location)}`;
}

/**
 * The grouping keys that prove a duplicate: full workplace and source
 * identity. Empty when the record carries neither proof.
 *
 * @param {object} job
 * @returns {string[]}
 */
export function housekeepingDuplicateKeys(job) {
  const title = normalized(job?.title);
  const company = normalized(job?.company);
  if (!title) return [];
  const keys = [];
  const postalCode = normalized(job?.postalCode);
  const streetAddress = normalized(job?.streetAddress);
  if (postalCode && streetAddress) {
    keys.push(`place\u0000${title}\u0000${company}\u0000${normalized(job?.location)}\u0000${postalCode}\u0000${streetAddress}`);
  }
  const sourceKey = mergeUrlKey(String(job?.url || ''));
  if (sourceKey) keys.push(`source\u0000${title}\u0000${company}\u0000${normalized(job?.location)}\u0000${sourceKey}`);
  return keys;
}

function crawledAtMs(job) {
  return job?.crawledAt ? new Date(job.crawledAt).getTime() : 0;
}

/**
 * Remove the duplicate postings, keeping the newest `crawledAt` of each group
 * at the position of the first record seen (the order `cleanup-jobs.mjs`
 * always produced).
 *
 * @template T
 * @param {T[]} jobs
 * @returns {{ kept: T[], removed: Array<{ loser: T, retained: T, duplicateKey: string }> }}
 */
export function dropHousekeepingDuplicatePostings(jobs = []) {
  const retainedByKey = new Map();
  const kept = [];
  const removed = [];
  for (const job of jobs) {
    const keys = housekeepingDuplicateKeys(job);
    const prev = keys.map((key) => retainedByKey.get(key)).find(Boolean);
    if (!prev) {
      for (const key of keys) retainedByKey.set(key, job);
      kept.push(job);
      continue;
    }
    let retained = prev;
    let loser = job;
    if (crawledAtMs(job) > crawledAtMs(prev)) {
      const idx = kept.indexOf(prev);
      if (idx !== -1) kept[idx] = job;
      retained = job;
      loser = prev;
    }
    for (const key of [...housekeepingDuplicateKeys(prev), ...keys]) retainedByKey.set(key, retained);
    removed.push({ loser, retained, duplicateKey: titleCompanyLocationKey(loser) });
  }
  return { kept, removed };
}
