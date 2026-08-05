/**
 * Shared Cloudflare cache-purge limits.
 *
 * Extracted (AGENTS.md #6 — a literal constant duplicated in ≥2 files goes in
 * ONE shared module so the copies cannot drift) because two scripts must agree
 * on Cloudflare's `files` purge cap:
 *   - scripts/cf-purge-cache.mjs            rejects a --files= list over the cap
 *   - scripts/ci/purge-changed-cdn-assets.mjs batches its keys UP TO the cap
 *
 * If those two ever disagreed, the batcher would hand cf-purge-cache.mjs a list
 * it refuses, and every deploy would log a failed purge for the batch that went
 * over — leaving those CDN keys edge-cached at stale bytes with no other signal.
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
