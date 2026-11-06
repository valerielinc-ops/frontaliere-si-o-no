import { buildAssembledJobIdentity } from './job-identity.mjs';

/**
 * Identity function for assembler collapse/merge passes.
 *
 * URLs and stable vendor IDs prove records may be compared across slices.
 * A slug or title/location fallback does not: collisions are possible, and
 * discarding one ambiguous record would silently lose a posting. Give each
 * unkeyed object an in-run identity so it survives those passes for the later
 * route disambiguator to handle.
 */
export function createAssemblerDedupIdentity() {
  const ambiguousIds = new WeakMap();
  let nextAmbiguousId = 0;

  return function assemblerDedupIdentity(job) {
    const identity = buildAssembledJobIdentity(job || {});
    if (identity.startsWith('url:') || identity.startsWith('id:')) return identity;

    if (!job || (typeof job !== 'object' && typeof job !== 'function')) {
      nextAmbiguousId += 1;
      return `ambiguous:primitive:${nextAmbiguousId}`;
    }

    let ambiguousId = ambiguousIds.get(job);
    if (!ambiguousId) {
      nextAmbiguousId += 1;
      ambiguousId = `ambiguous:object:${nextAmbiguousId}`;
      ambiguousIds.set(job, ambiguousId);
    }
    return ambiguousId;
  };
}
