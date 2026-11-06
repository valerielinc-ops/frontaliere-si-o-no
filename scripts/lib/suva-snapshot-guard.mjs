/**
 * Fail-closed guard for the Suva sitemap/detail boundary.
 *
 * The sitemap is the authoritative list of live detail URLs. Returning the
 * successfully parsed subset when one or more detail requests fail turns a
 * transient fetch problem into an apparent vacancy retirement; the next
 * healthy run then resurrects those jobs and pollutes the expired archive.
 */

/**
 * Build the standard crawler-template source-extraction error for an
 * incomplete Suva detail snapshot.
 *
 * @param {unknown[]} jobUrls
 * @param {unknown[]} jobs
 * @returns {Error & {specDetailDrop?: {candidates: number, gone: number, rejected: number}, specDiscoveredCount?: number} | null}
 */
export function suvaDetailSnapshotFailure(jobUrls, jobs) {
  const candidates = Array.isArray(jobUrls) ? jobUrls.length : 0;
  const parsed = Array.isArray(jobs) ? jobs.length : 0;
  const dropped = candidates - parsed;
  if (candidates === 0 || dropped <= 0) return null;

  const error = new Error(
    `Suva detail snapshot incomplete: parsed ${parsed}/${candidates}; refusing partial publication.`,
  );
  error.specDetailDrop = {
    candidates,
    gone: 0,
    rejected: dropped,
  };
  error.specDiscoveredCount = candidates;
  return error;
}

/**
 * Throw when the sitemap/detail snapshot is incomplete.
 *
 * @param {unknown[]} jobUrls
 * @param {unknown[]} jobs
 * @returns {true}
 */
export function assertSuvaDetailSnapshotComplete(jobUrls, jobs) {
  const failure = suvaDetailSnapshotFailure(jobUrls, jobs);
  if (failure) throw failure;
  return true;
}
