/**
 * Shared Cloudflare cache-purge limits.
 *
 * Extracted (AGENTS.md #6 — a literal constant duplicated in ≥2 files goes in
 * ONE shared module so the copies cannot drift) because purge callers must
 * agree on Cloudflare's targeted operation caps:
 *   - scripts/cf-purge-cache.mjs            rejects a --files= list over the cap
 *   - scripts/ci/purge-changed-cdn-assets.mjs batches its keys UP TO the cap
 *   - scripts/cf-purge-worker-origin-cache.mjs batches origin hosts UP TO the
 *     host cap
 *
 * If those callers ever disagreed, a batcher would hand Cloudflare a request it
 * refuses, leaving the targeted cache entries stale with no other signal.
 *
 * cf-purge-cache.mjs cannot simply be imported for this value: it runs its work
 * at module scope and calls process.exit(), so importing it would fire a real
 * purge as a side effect.
 */

/**
 * Cloudflare free-plan cap on URLs per `purge_cache` `files` request.
 * Over the cap the API rejects the whole call, so callers must batch.
 */
export const MAX_TARGETED_FILES = 30;

/** Cloudflare cap on hostnames in one host-scoped purge request. */
export const MAX_TARGETED_HOSTS = 100;
