#!/usr/bin/env node
/**
 * Purge the native cache entries on the Worker shard origins after a cache
 * policy rollout.
 *
 * `cacheTtlByStatus` changes how future origin responses are written, but it
 * cannot evict a 5xx that the old uniform `cacheTtl` already stored. The
 * Worker fetches its locale and section shards through `origin-*` hostnames,
 * so a hostname purge clears the old native entries without touching the apex
 * site cache or the high-hit CDN host.
 *
 * This is intentionally separate from scripts/cf-purge-cache.mjs's
 * deploy-content purge: it uses Cloudflare's host-scoped purge primitive, not
 * `purge_everything`, and is run only when the Worker cache policy changes.
 * The origin host list is derived from the Worker routing tables so a new
 * shard cannot silently remain on the old cache contract.
 *
 * Auth: CF_API_TOKEN (Zone -> Cache Purge), optionally CF_ZONE_ID and
 * CF_ZONE_NAME. CI hydrates these through scripts/load-rc-env.mjs.
 */
import { pathToFileURL } from 'node:url';

import { DEFAULT_ZONE_NAME, REST_BASE, resolveZoneId } from './lib/cf-analytics.mjs';
import { MAX_TARGETED_HOSTS } from './lib/cf-purge-limits.mjs';
import { SECTION_ORIGIN, SHARD_ORIGIN } from '../infra/cloudflare-worker/locale-router.js';

export const WORKER_ORIGIN_HOSTS = Object.freeze(
  [
    ...Object.values(SHARD_ORIGIN),
    ...Object.values(SECTION_ORIGIN).flatMap((origins) => Object.values(origins)),
  ].filter((host, index, hosts) => hosts.indexOf(host) === index).sort(),
);

export function workerOriginPurgeBatches(hosts = WORKER_ORIGIN_HOSTS) {
  const batches = [];
  for (let i = 0; i < hosts.length; i += MAX_TARGETED_HOSTS) {
    batches.push(hosts.slice(i, i + MAX_TARGETED_HOSTS));
  }
  return batches;
}

export function workerOriginPurgeBody(hosts) {
  return { hosts: [...hosts] };
}

/**
 * Purge every native cache entry for the origin hosts used by the Worker.
 *
 * `fetchImpl` is injectable so the contract can be tested without sending a
 * real Cloudflare request.
 */
export async function purgeWorkerOriginCache({
  token = process.env.CF_API_TOKEN,
  zoneId = process.env.CF_ZONE_ID,
  zoneName = process.env.CF_ZONE_NAME || DEFAULT_ZONE_NAME,
  fetchImpl = fetch,
} = {}) {
  if (!token) throw new Error('CF_API_TOKEN not set (hydrate via scripts/load-rc-env.mjs).');

  const resolvedZoneId = zoneId || (await resolveZoneId(token, zoneName, undefined, fetchImpl));
  const batches = workerOriginPurgeBatches();
  const results = [];
  for (const [index, hosts] of batches.entries()) {
    const body = workerOriginPurgeBody(hosts);
    const response = await fetchImpl(`${REST_BASE}/zones/${resolvedZoneId}/purge_cache`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    if (!json?.success) {
      throw new Error(
        `Worker origin cache purge failed for batch ${index + 1}/${batches.length}: ` +
          `${JSON.stringify(json?.errors ?? { httpStatus: response.status })}`,
      );
    }
    results.push({ body, json });
  }
  return { zoneId: resolvedZoneId, batches: results };
}

async function main() {
  const { zoneId, batches } = await purgeWorkerOriginCache();
  console.log(
    `✅ Native Worker origin cache purged for ${WORKER_ORIGIN_HOSTS.length} host(s) ` +
      `in ${batches.length} request(s) (zone ${zoneId}):`,
  );
  for (const host of WORKER_ORIGIN_HOSTS) console.log(`   - ${host}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
}
