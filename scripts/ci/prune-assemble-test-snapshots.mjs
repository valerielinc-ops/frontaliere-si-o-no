// Age-based prune of the assemble test snapshot caches.
//
// Several producers (hourly seed, push runs of tests.yml on main) save
// snapshot caches, and a manifest stays usable for 60 minutes after its capture
// time. "Keep the newest N" would delete a key a fresh manifest still names, so
// only caches that nobody wrote and nobody read for MIN_AGE_MS go.
export const SNAPSHOT_CACHE_PREFIX = 'assemble-jobs-test-snapshot-Linux-';
export const PRUNE_MIN_AGE_MS = 3 * 60 * 60 * 1000;

// A cache with a missing or unparsable timestamp is kept: deleting is the
// irreversible direction.
export function selectCachesToPrune({
  caches, currentKey = '', now = Date.now(), prefix = SNAPSHOT_CACHE_PREFIX, minAgeMs = PRUNE_MIN_AGE_MS,
}) {
  return (caches || []).filter((cache) => {
    if (!cache || typeof cache.key !== 'string' || !cache.key.startsWith(prefix)) return false;
    if (cache.key === currentKey) return false;
    const created = Date.parse(cache.created_at || '');
    const accessed = Date.parse(cache.last_accessed_at || '');
    if (!Number.isFinite(created) || !Number.isFinite(accessed)) return false;
    return now - created > minAgeMs && now - accessed > minAgeMs;
  });
}

export async function pruneAssembleTestSnapshots({ github, context, core, currentKey = '', now = Date.now() }) {
  const caches = await github.paginate(
    github.rest.actions.getActionsCacheList,
    {
      owner: context.repo.owner,
      repo: context.repo.repo,
      ref: 'refs/heads/main',
      key: SNAPSHOT_CACHE_PREFIX,
      per_page: 100,
    },
    (response) => response.data.actions_caches,
  );
  const doomed = selectCachesToPrune({ caches, currentKey, now });
  for (const cache of doomed) {
    await github.rest.actions.deleteActionsCacheById({
      owner: context.repo.owner,
      repo: context.repo.repo,
      cache_id: cache.id,
    });
    core.info(`Deleted test snapshot cache ${cache.key} (created ${cache.created_at}, last used ${cache.last_accessed_at})`);
  }
  return doomed.length;
}
