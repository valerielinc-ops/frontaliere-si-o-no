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
 *     `grams.get(token)` for tokens of length <= 2 and `grams.get(g)` for the
 *     3-grams `g` of longer tokens, and compares list LENGTHS to pick the
 *     rarest. A gram's posting list only depends on which haystacks contain
 *     it, so restricting the index to the queried grams leaves every list the
 *     rarest-gram choice sees — and therefore every result — unchanged. The
 *     gain is that the per-position work drops from "slice + Set + Map push"
 *     for ~all grams to one `Set.has` on a small wanted set.
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
 * @returns {{ wanted2: Set<string>, wanted3: Set<string> }}
 */
export function wantedGramsForTokens(tokens) {
  const wanted2 = new Set();
  const wanted3 = new Set();
  for (const token of tokens) {
    if (token.length <= 2) {
      // Only width-2 grams exist for a 2-char token; a 1-char token can never
      // be a key of the index, so it needs nothing.
      if (token.length === 2 && isSearchTokenGram(token)) wanted2.add(token);
      continue;
    }
    for (let i = 0; i <= token.length - 3; i++) {
      const gram = token.slice(i, i + 3);
      if (isSearchTokenGram(gram)) wanted3.add(gram);
    }
  }
  return { wanted2, wanted3 };
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
 * @param {{ wanted2: Set<string>, wanted3: Set<string> }} wanted
 * @returns {Map<string, number[]>}
 */
function buildSparseGramIndex(haystacks, wanted) {
  /** @type {Map<string, number[]>} */
  const grams = new Map();
  /** @type {Map<string, number>} last job index pushed per gram */
  const lastJob = new Map();
  const widths = [];
  if (wanted.wanted2.size > 0) widths.push([2, wanted.wanted2]);
  if (wanted.wanted3.size > 0) widths.push([3, wanted.wanted3]);
  for (let jobIdx = 0; jobIdx < haystacks.length; jobIdx++) {
    const haystack = haystacks[jobIdx];
    for (const [width, set] of widths) {
      if (haystack.length < width) continue;
      for (let i = 0; i <= haystack.length - width; i++) {
        const gram = haystack.slice(i, i + width);
        // Wanted grams already passed isSearchTokenGram.
        if (!set.has(gram)) continue;
        if (lastJob.get(gram) === jobIdx) continue;
        lastJob.set(gram, jobIdx);
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
 * @param {Map<string, number[]>} grams
 * @returns {number[]}
 */
export function intersectedCandidatesForToken(token, grams) {
  if (token.length <= 2) return grams.get(token) ?? [];
  /** @type {number[][]} */
  const lists = [];
  const seenTokenGrams = new Set();
  for (let i = 0; i <= token.length - 3; i++) {
    const gram = token.slice(i, i + 3);
    if (seenTokenGrams.has(gram)) continue;
    seenTokenGrams.add(gram);
    const list = grams.get(gram);
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

  const grams = sparse
    ? buildSparseGramIndex(haystacks, wantedGramsForTokens(tokens))
    : buildDenseGramIndex(haystacks);
  if (timings) {
    const now = performance.now();
    timings.index = now - t;
    t = now;
  }

  /** @param {string} token */
  const candidateJobsForToken = (token) => {
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
  };

  /** @type {Array<{ token: string, list: number[] }>} */
  const entries = new Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const candidates = sparse ? intersectedCandidatesForToken(token, grams) : candidateJobsForToken(token);
    const list = [];
    for (const idx of candidates) {
      if (haystacks[idx].includes(token)) list.push(idx);
    }
    entries[i] = { token, list };
  }
  if (timings) timings.resolve = performance.now() - t;
  return entries;
}
