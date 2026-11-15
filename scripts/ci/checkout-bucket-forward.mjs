/**
 * Buckets of the sparse-checkout profiles that are declared BEFORE their data
 * is on `main`.
 *
 * `generate-checkout-buckets.mjs` measures the tree of `origin/main`, so a
 * directory that a PR introduces (and that a pipeline, not the PR, fills) is
 * invisible to it until the first commit lands. For those, a profile
 * regenerated in the PR itself would leave every sparse workflow (about 150)
 * materialising the new directory, which is exactly what buckets exist to
 * avoid. A forward bucket is added to the table only while the measured tree
 * does NOT contain the id yet: the first measurement that sees the directory
 * replaces the estimate, and this list can be emptied then.
 */

/**
 * @typedef {{ id: string, mb: number, files: number, reason: string }} ForwardBucket
 */

/** @type {readonly ForwardBucket[]} */
export const FORWARD_BUCKETS = Object.freeze([
  {
    // Sharded url-first-seen ledger (scripts/lib/url-first-seen-store.mjs): 16
    // shards, 2 170 968 entries measured on 2026-11-15 = 223 911 659 B in 16
    // files (13.9-14.1 MB each). Written by the publisher pipeline, so it reaches
    // `main` after this change does. Today the legacy file carries the same
    // data (bucket `data/url-first-seen.json`).
    id: 'data/url-first-seen/',
    mb: 214,
    files: 16,
    reason: 'sharded url-first-seen ledger, written by the publish pipeline after the PR that introduces it',
  },
]);

/**
 * Add the forward buckets that the measurement does not know yet, and account
 * for them in the tree totals (the tree WILL contain them), so the baseline
 * stays what the measurement said.
 *
 * @param {{ buckets: Array<{ id: string, mb: number, files: number }>, treeMb: number, treeFiles: number }} payload
 * @param {readonly ForwardBucket[]} [forward]
 */
export function applyForwardBuckets(payload, forward = FORWARD_BUCKETS) {
  const known = new Set(payload.buckets.map((b) => b.id));
  const added = forward.filter((b) => !known.has(b.id));
  if (added.length === 0) return payload;
  const buckets = [
    ...payload.buckets,
    ...added.map(({ id, mb, files }) => ({ id, mb, files, forward: true })),
  ].sort((a, b) => b.mb - a.mb);
  return {
    ...payload,
    buckets,
    treeMb: payload.treeMb + added.reduce((sum, b) => sum + b.mb, 0),
    treeFiles: payload.treeFiles + added.reduce((sum, b) => sum + b.files, 0),
  };
}
