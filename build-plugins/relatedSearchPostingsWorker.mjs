/**
 * Worker for relatedSearchClustersPlugin's postings pre-pass.
 *
 * Each instance owns ONE locale. It receives the full jobs array + the set
 * of tokens that will be queried during `build-contexts`. For that locale
 * it:
 *   1. builds the per-locale haystack array (mirror of TokenIndex.getHaystacks),
 *   2. builds the 2/3-gram inverted index (mirror of getGramPostings),
 *   3. for each requested token, resolves the posting list via the same
 *      "rarest 3-gram" strategy as TokenIndex.candidateJobsForToken,
 *      then filters by `haystack.includes(token)`.
 *
 * Returns `{ locale, entries: [{ token, list }] }`. The coordinator seeds
 * `TokenIndex.postingsByLocale` with these before the build-contexts loop
 * runs, turning every cold postings-miss into a cache hit.
 *
 * Output is byte-identical: the helper functions below are verbatim copies
 * of their counterparts in relatedSearchClustersPlugin.ts. Pure JS, no I/O,
 * no .ts imports — boots without tsx loader. The stemming step is imported
 * from services/searchStem.mjs (also pure JS) so it can NEVER drift from the
 * plugin's `stemHaystack`; the queried `tokens` arrive already stemmed by the
 * plugin's tokenizeQuery, so the haystack here must be stemmed identically.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { stemHaystack } from '../services/searchStem.mjs';

if (!parentPort) {
  throw new Error('[relatedSearchPostingsWorker] must be spawned via worker_threads');
}

/** @param {string} value */
function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * `cantonSearch` is the canton-name token string ("ticino tessin") precomputed
 * by the plugin (which alone can read the canton JSON) so this haystack stays
 * byte-identical to relatedSearchClustersPlugin.buildJobHaystack (issue #2967).
 * @param {{ titleByLocale?: Record<string,string>, descriptionByLocale?: Record<string,string>, title?: string, description?: string, company?: string, location?: string, cantonSearch?: string }} job
 * @param {string} locale
 */
function buildJobHaystack(job, locale) {
  const title = job.titleByLocale?.[locale] ?? job.title ?? '';
  const description = job.descriptionByLocale?.[locale] ?? job.description ?? '';
  return stemHaystack(normalizeText(`${title} ${job.company ?? ''} ${job.location ?? ''} ${job.cantonSearch ?? ''} ${description}`));
}

/** @param {string} value */
function isSearchTokenGram(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isDigit = code >= 48 && code <= 57;
    const isLowerAscii = code >= 97 && code <= 122;
    if (!isDigit && !isLowerAscii) return false;
  }
  return true;
}

const { jobs, locale, tokens } = /** @type {{ jobs: any[], locale: string, tokens: string[] }} */ (workerData);

const haystacks = new Array(jobs.length);
for (let i = 0; i < jobs.length; i++) {
  haystacks[i] = buildJobHaystack(jobs[i], locale);
}

/** @type {Map<string, number[]>} */
const grams = new Map();
const seenInJob = new Set();
for (let jobIdx = 0; jobIdx < haystacks.length; jobIdx++) {
  const haystack = haystacks[jobIdx];
  seenInJob.clear();
  for (const width of [2, 3]) {
    if (haystack.length < width) continue;
    for (let i = 0; i <= haystack.length - width; i++) {
      const gram = haystack.slice(i, i + width);
      if (!isSearchTokenGram(gram)) continue;
      if (seenInJob.has(gram)) continue;
      seenInJob.add(gram);
      let list = grams.get(gram);
      if (!list) {
        list = [];
        grams.set(gram, list);
      }
      list.push(jobIdx);
    }
  }
}

/** @param {string} token */
function candidateJobsForToken(token) {
  if (token.length <= 2) {
    return grams.get(token) ?? [];
  }
  /** @type {number[] | null} */
  let rarest = null;
  const seenTokenGrams = new Set();
  for (let i = 0; i <= token.length - 3; i++) {
    const gram = token.slice(i, i + 3);
    if (seenTokenGrams.has(gram)) continue;
    seenTokenGrams.add(gram);
    const list = grams.get(gram) ?? [];
    if (rarest === null || list.length < rarest.length) {
      rarest = list;
      if (rarest.length === 0) break;
    }
  }
  return rarest ?? [];
}

/** @type {Array<{ token: string, list: number[] }>} */
const entries = new Array(tokens.length);
for (let i = 0; i < tokens.length; i++) {
  const token = tokens[i];
  const candidates = candidateJobsForToken(token);
  const list = [];
  for (const idx of candidates) {
    if (haystacks[idx].includes(token)) list.push(idx);
  }
  entries[i] = { token, list };
}

parentPort.postMessage({ locale, entries });
