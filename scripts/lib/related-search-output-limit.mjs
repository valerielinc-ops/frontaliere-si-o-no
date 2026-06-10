/**
 * Push-safety ceilings for the related-search data files
 * (`data/related-search-enriched.json`, `data/related-search-candidates.json`).
 *
 * GitHub's hard push limit is 100 MB. We abort below it to leave headroom and
 * catch runaway growth before it reaches the hard limit (#1576, #1651, #1658).
 *
 * The two files have very different growth profiles, so they get DIFFERENT
 * ceilings — a single shared ceiling would couple the legitimately-large
 * `candidates` long-tail corpus to the writer's much smaller `enriched` output,
 * so that `candidates` crossing the writer's bound would block the entire
 * weekly Commit step (and with it the unrelated `jobs-snapshots-history/`,
 * `weekly-employers-delta.json`, `top-pairs.json` commits that feed the
 * weekly-employers SEO landings):
 *
 * - `related-search-enriched.json` — writer output (AI intros + FAQ), ~9.5 MB.
 *   A jump toward 50 MB means a runaway `--force` re-enrich on a bloated input,
 *   so 50 MB is a tight runaway tripwire.
 * - `related-search-candidates.json` — long-tail candidate corpus, ~46.8 MB and
 *   growing organically. Its prune is a product decision (#1658 item 1); until
 *   then it gets a higher 90 MB ceiling (still 10 MB under the GitHub hard
 *   limit) so organic growth in the 50-90 MB band keeps pushing instead of
 *   blocking the legitimate weekly snapshot commit.
 *
 * Single source of truth shared by the writer (`enrich-related-search-clusters.mjs`,
 * which exits non-zero on overflow of its `enriched` output) and the commit gate
 * (`assert-file-size-ceiling.mjs`, invoked by snapshot-jobs-weekly.yml before
 * `git add` so an oversize file is never staged even when the enrich step runs
 * under `continue-on-error: true`).
 */
const MB = 1024 * 1024;

/** Ceiling for the writer's `related-search-enriched.json` output. */
export const OUTPUT_SIZE_LIMIT_BYTES = 50 * MB; // 50 MB

/** Higher ceiling for the organically-growing `related-search-candidates.json` corpus. */
export const CANDIDATES_SIZE_LIMIT_BYTES = 90 * MB; // 90 MB

/**
 * Resolve the push-safety ceiling for a given related-search file path.
 * Defaults to the tight `OUTPUT_SIZE_LIMIT_BYTES` for any unrecognized file.
 */
export function sizeLimitForPath(path) {
  return /related-search-candidates\.json$/.test(path)
    ? CANDIDATES_SIZE_LIMIT_BYTES
    : OUTPUT_SIZE_LIMIT_BYTES;
}
