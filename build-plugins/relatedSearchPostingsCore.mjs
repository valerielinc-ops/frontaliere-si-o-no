/**
 * Pure core of the related-search postings pre-pass (relatedSearchPostingsWorker).
 *
 * Kept free of `worker_threads` so tests and benches can call it in-process.
 * The worker imports it; the plugin never does (the plugin keeps its own
 * TokenIndex, which this module mirrors byte-for-byte).
 *
 * Two index strategies, same output:
 *   - dense  (default): index EVERY 2- and 3-gram of every haystack, then look
 *     up the grams of each requested token. This is the historical behaviour.
 *   - sparse (RELATED_SEARCH_POSTINGS_SPARSE=1): index ONLY the grams a
 *     requested token can ever look up. `candidateJobsForToken` reads just
 *     numeric keys for only the width-2/3 grams a requested token can read.
 *     A gram's posting list only depends on which haystacks contain it, so
 *     restricting the index to queried grams leaves every result unchanged.
 *     Numeric keys also avoid a short-lived substring allocation for every
 *     haystack position.
 *
 * @module relatedSearchPostingsCore
 */
import { stemHaystack } from '../services/searchStem.mjs';

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
export function buildJobHaystack(job, locale) {
  const title = job.titleByLocale?.[locale] ?? job.title ?? '';
  const description = job.descriptionByLocale?.[locale] ?? job.description ?? '';
  return stemHaystack(normalizeText(`${title} ${job.company ?? ''} ${job.location ?? ''} ${job.cantonSearch ?? ''} ${description}`));
}

/**
 * The worker payload for ONE locale: the five fields buildJobHaystack reads
 * for that locale, already resolved, and nothing else (issue #12763).
 *
 * The pre-pass used to structured-clone `titleByLocale` and
 * `descriptionByLocale` of every job into a worker that reads one locale only.
 * The descriptions of the four locales plus the base one are ~80% of the
 * payload, and the clone (serialized buffer on the main side + a second copy
 * in the worker heap) is the transient that pushed the de/fr legs over the
 * build-mem-guard ceiling in runs 40070380153, 40057008446 and 40041643721:
 * the guard fired between `shared matching summary loaded` and the end of the
 * pre-pass every time. Measured on a 22.5k-job corpus: 277M -> 56M payload
 * chars, worker transient RSS 1142 -> 642 MB.
 *
 * The haystack is byte-identical: `title`/`description` hold exactly the value
 * `titleByLocale?.[locale] ?? title` / `descriptionByLocale?.[locale] ??
 * description` that buildJobHaystack would pick, and without the by-locale maps
 * buildJobHaystack falls through to them. Strings are shared by reference, so
 * the projection costs one small object per job on the main thread.
 *
 * @param {ReadonlyArray<{ titleByLocale?: Record<string,string>, descriptionByLocale?: Record<string,string>, title?: string, description?: string, company?: string, location?: string }>} jobs
 * @param {string} locale
 * @param {ReadonlyArray<string>} cantonSearchByJob same order and length as `jobs`
 * @returns {{ jobs: Array<{ title?: string, description?: string, company?: string, location?: string, cantonSearch?: string }>, payloadChars: number }}
 */
export function projectJobsForLocaleHaystack(jobs, locale, cantonSearchByJob) {
  const out = new Array(jobs.length);
  let payloadChars = 0;
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const title = job.titleByLocale?.[locale] ?? job.title;
    const description = job.descriptionByLocale?.[locale] ?? job.description;
    const cantonSearch = cantonSearchByJob[i];
    out[i] = { title, description, company: job.company, location: job.location, cantonSearch };
    payloadChars += (typeof title === 'string' ? title.length : 0)
      + (typeof description === 'string' ? description.length : 0);
  }
  return { jobs: out, payloadChars };
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

/**
 * Every gram `candidateJobsForToken` may read for these tokens.
 * @param {readonly string[]} tokens
 * @returns {{ wanted2: Set<number>, wanted3: Set<number> }}
 */
export function wantedGramsForTokens(tokens) {
  const wanted2 = new Set();
  const wanted3 = new Set();
  for (const token of tokens) {
    if (token.length <= 2) {
      // Only width-2 grams exist for a 2-char token; a 1-char token can never
      // be a key of the index, so it needs nothing.
      if (token.length === 2) {
        const gram = encodeSearchGramAt(token, 0, 2);
        if (gram >= 0) wanted2.add(gram);
      }
      continue;
    }
    for (let i = 0; i <= token.length - 3; i++) {
      const gram = encodeSearchGramAt(token, i, 3);
      if (gram >= 0) wanted3.add(gram);
    }
  }
  return { wanted2, wanted3 };
}

const SEARCH_GRAM_BASE = 36;

/**
 * Encode a fixed-width ASCII lowercase alphanumeric gram without allocating a
 * substring. Postings indexes scan every job haystack; calling `slice()` for
 * every 2/3-gram created hundreds of millions of short-lived strings on the
 * production corpus even when most grams were immediately discarded.
 * Separate 2- and 3-gram maps keep these numeric keys unambiguous.
 * @param {string} value
 * @param {number} start
 * @param {number} width
 * @returns {number}
 */
export function encodeSearchGramAt(value, start, width) {
  let encoded = 0;
  for (let i = start; i < start + width; i++) {
    const code = value.charCodeAt(i);
    const digit = code >= 48 && code <= 57
      ? code - 48 + 26
      : code >= 97 && code <= 122
        ? code - 97
        : -1;
    if (digit < 0) return -1;
    encoded = encoded * SEARCH_GRAM_BASE + digit;
  }
  return encoded;
}

/** Test helper for fixed-width ASCII alphanumeric grams. */
export function encodeSearchGram(value) {
  if (value.length !== 2 && value.length !== 3) return -1;
  return encodeSearchGramAt(value, 0, value.length);
}

/**
 * @param {string[]} haystacks
 * @returns {Map<string, number[]>}
 */
function buildDenseGramIndex(haystacks) {
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
  return grams;
}

/**
 * Same lists as the dense index for every wanted gram; unwanted grams absent.
 * Job indexes are pushed in ascending order exactly once per (gram, job), as
 * in the dense build.
 * @param {string[]} haystacks
 * @param {{ wanted2: Set<number>, wanted3: Set<number> }} wanted
 * @returns {{ grams2: Map<number, number[]>, grams3: Map<number, number[]> }}
 */
function buildSparseGramIndex(haystacks, wanted) {
  /** @type {Map<number, number[]>} */
  const grams2 = new Map();
  /** @type {Map<number, number[]>} */
  const grams3 = new Map();
  // A gram is inserted once per job. Per-job sets stay bounded by that one
  // haystack and avoid retaining a second full-corpus Map<gram,lastJob>.
  const seen2 = new Set();
  const seen3 = new Set();
  const widths = [];
  if (wanted.wanted2.size > 0) widths.push([2, wanted.wanted2]);
  if (wanted.wanted3.size > 0) widths.push([3, wanted.wanted3]);
  for (let jobIdx = 0; jobIdx < haystacks.length; jobIdx++) {
    const haystack = haystacks[jobIdx];
    seen2.clear();
    seen3.clear();
    for (const [width, set] of widths) {
      if (haystack.length < width) continue;
      for (let i = 0; i <= haystack.length - width; i++) {
        const gram = encodeSearchGramAt(haystack, i, width);
        if (gram < 0 || !set.has(gram)) continue;
        const seen = width === 2 ? seen2 : seen3;
        if (seen.has(gram)) continue;
        seen.add(gram);
        const grams = width === 2 ? grams2 : grams3;
        let list = grams.get(gram);
        if (!list) {
          list = [];
          grams.set(gram, list);
        }
        list.push(jobIdx);
      }
    }
  }
  return { grams2, grams3 };
}

/** @param {number[]} sorted @param {number} value */
function sortedHas(sorted, value) {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = sorted[mid];
    if (v === value) return true;
    if (v < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/**
 * Candidates = jobs containing EVERY 3-gram of the token (the dense path uses
 * only the rarest one). Any job whose haystack contains the token contains all
 * its 3-grams, so this is still a superset of the true matches, in the same
 * ascending order; the `includes` filter that follows therefore returns the
 * identical list while running on far fewer haystacks.
 * @param {string} token
 * @param {{ grams2: Map<number, number[]>, grams3: Map<number, number[]> }} grams
 * @returns {number[]}
 */
export function intersectedCandidatesForToken(token, grams) {
  if (token.length <= 2) {
    if (token.length !== 2) return [];
    const gram = encodeSearchGramAt(token, 0, 2);
    return gram < 0 ? [] : (grams.grams2.get(gram) ?? []);
  }
  /** @type {number[][]} */
  const lists = [];
  const seenTokenGrams = new Set();
  for (let i = 0; i <= token.length - 3; i++) {
    const gram = encodeSearchGramAt(token, i, 3);
    // Dense postings have no entry for a non-alphanumeric gram, so any token
    // containing one has no candidates in the sparse index either.
    if (gram < 0) return [];
    if (seenTokenGrams.has(gram)) continue;
    seenTokenGrams.add(gram);
    const list = grams.grams3.get(gram);
    if (!list || list.length === 0) return [];
    lists.push(list);
  }
  if (lists.length === 0) return [];
  lists.sort((a, b) => a.length - b.length);
  let candidates = lists[0];
  for (let k = 1; k < lists.length && candidates.length > 0; k++) {
    const other = lists[k];
    candidates = candidates.filter((idx) => sortedHas(other, idx));
  }
  return candidates;
}

/**
 * Resolve the posting list (job indexes whose haystack contains the token)
 * for each requested token.
 * @param {{ jobs: any[], locale: string, tokens: string[], sparse?: boolean, timings?: Record<string, number> }} input
 * @returns {Array<{ token: string, list: number[] }>}
 */
export function computeTokenPostings({ jobs, locale, tokens, sparse = false, timings }) {
  let t = performance.now();
  const haystacks = new Array(jobs.length);
  for (let i = 0; i < jobs.length; i++) {
    haystacks[i] = buildJobHaystack(jobs[i], locale);
  }
  if (timings) {
    const now = performance.now();
    timings.haystacks = now - t;
    t = now;
  }

  const sparseGrams = sparse
    ? buildSparseGramIndex(haystacks, wantedGramsForTokens(tokens))
    : null;
  const denseGrams = sparse ? null : buildDenseGramIndex(haystacks);
  if (timings) {
    const now = performance.now();
    timings.index = now - t;
    t = now;
  }

  /** @param {string} token */
  const candidateJobsForToken = (token) => {
    if (!denseGrams) return [];
    if (token.length <= 2) {
      return denseGrams.get(token) ?? [];
    }
    /** @type {number[] | null} */
    let rarest = null;
    const seenTokenGrams = new Set();
    for (let i = 0; i <= token.length - 3; i++) {
      const gram = token.slice(i, i + 3);
      if (seenTokenGrams.has(gram)) continue;
      seenTokenGrams.add(gram);
      const list = denseGrams.get(gram) ?? [];
      if (rarest === null || list.length < rarest.length) {
        rarest = list;
        if (rarest.length === 0) break;
      }
    }
    return rarest ?? [];
  };

  /** @type {Array<{ token: string, list: number[] }>} */
  const entries = new Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const candidates = sparse
      ? (sparseGrams ? intersectedCandidatesForToken(token, sparseGrams) : [])
      : candidateJobsForToken(token);
    const list = [];
    for (const idx of candidates) {
      if (haystacks[idx].includes(token)) list.push(idx);
    }
    entries[i] = { token, list };
  }
  if (timings) timings.resolve = performance.now() - t;
  return entries;
}
