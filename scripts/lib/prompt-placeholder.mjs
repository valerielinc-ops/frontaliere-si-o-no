/**
 * Detects a JSON-skeleton slot the model handed back instead of filling.
 *
 * `scripts/enrich-related-search-clusters.mjs` prompts for a fixed JSON shape
 * whose slots are literal placeholders:
 *
 *   { "intro": "<80-120 word prose paragraph, single paragraph, no line breaks>",
 *     "faqs": [ {"q": "<question, max 80 chars>", "a": "<answer, max 80 words>"},
 *               {"q": "...", "a": "..."} ] }
 *
 * When the model echoes that skeleton, every structural check still passes —
 * the values are non-empty strings and the FAQ count is right — so the echo is
 * accepted, written with a `cachedFor` stamp, and never retried. 76 of the
 * 7,089 entries in `data/related-search-enriched.json` are in that state as of
 * 2026-08-06, the oldest stamped 2026-07-13.
 *
 * Shared deliberately by BOTH sides of the pipeline:
 *
 *   • the producer (`scripts/enrich-related-search-clusters.mjs`), which now
 *     rejects an echo and burns its retry instead of caching it, and
 *   • the consumer (`build-plugins/relatedSearchClustersPlugin.ts`, via
 *     `hasUsableEnrichedIntro`), which must not treat an already-cached echo as
 *     the editorial value that exempts a cluster from
 *     MIN_JOBS_FOR_INDEXABLE_CLUSTER.
 *
 * One definition, because a producer and a consumer that each carry their own
 * copy of "what counts as real content" is precisely the divergence shape that
 * put 106,276 noindex URLs into sitemap-search-clusters-*.xml.
 *
 * Deliberately narrow: this recognises values that are provably fill-in slots,
 * not values that are merely poor. "Too short to be good" is a quality
 * judgement for the enrichment pipeline; "this is the prompt" is a defect.
 *
 * @param {unknown} value
 * @returns {boolean} true when `value` is an unfilled placeholder slot
 */
export function isPromptPlaceholder(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return false;
  // `<...>` with nothing outside it — the shape every slot in the prompt uses.
  if (/^<[^<>]*>$/.test(s)) return true;
  // The bare continuation marker the second and third FAQ entries carry.
  if (/^\.{3,}$/.test(s)) return true;
  return false;
}
