/**
 * Push-safety ceiling for the related-search data files
 * (`data/related-search-enriched.json`, `data/related-search-candidates.json`).
 *
 * GitHub's hard push limit is 100 MB; we abort at 50 MB to leave headroom and
 * catch runaway growth (e.g. a full --force re-enrich on a bloated candidates
 * set) before it reaches the hard limit (#1576, #1651).
 *
 * Single source of truth shared by the writer (`enrich-related-search-clusters.mjs`,
 * which exits non-zero on overflow) and the commit gate
 * (`assert-file-size-ceiling.mjs`, invoked by snapshot-jobs-weekly.yml before
 * `git add` so an oversize file is never staged even when the enrich step runs
 * under `continue-on-error: true`).
 */
export const OUTPUT_SIZE_LIMIT_BYTES = 50 * 1024 * 1024; // 50 MB
