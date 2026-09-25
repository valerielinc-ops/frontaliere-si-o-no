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
 * Output is byte-identical: the logic lives in relatedSearchPostingsCore.mjs,
 * whose helpers are verbatim copies of their counterparts in
 * relatedSearchClustersPlugin.ts. Pure JS, no I/O, no .ts imports — boots
 * without tsx loader. The stemming step is imported from
 * services/searchStem.mjs (also pure JS) so it can NEVER drift from the
 * plugin's `stemHaystack`; the queried `tokens` arrive already stemmed by the
 * plugin's tokenizeQuery, so the haystack here must be stemmed identically.
 *
 * `sparse` (repository variable RELATED_SEARCH_POSTINGS_SPARSE=1, off by
 * default) indexes only the grams the requested tokens can read and
 * intersects all of a token's 3-gram lists before the `includes` filter.
 * Same entries, less work: see relatedSearchPostingsCore.mjs.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { computeTokenPostings } from './relatedSearchPostingsCore.mjs';

if (!parentPort) {
  throw new Error('[relatedSearchPostingsWorker] must be spawned via worker_threads');
}

const { jobs, locale, tokens, sparse } = /** @type {{ jobs: any[], locale: string, tokens: string[], sparse?: boolean }} */ (workerData);

/** @type {Record<string, number>} */
const timings = {};
const entries = computeTokenPostings({ jobs, locale, tokens, sparse: sparse === true, timings });

parentPort.postMessage({ locale, entries, timings });
