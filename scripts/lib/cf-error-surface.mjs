/**
 * cf-error-surface.mjs — the ONE taxonomy of this zone's error surfaces.
 *
 * Why it exists (2026-08-05). The `cloudflare-5xx` family was treated for weeks as a single
 * defect: "R2 does not answer and Cloudflare synthesises the 502". Measuring the zone with
 * `originResponseStatus` + `cacheStatus` showed it is at least THREE surfaces, with different
 * origins, that one label was hiding:
 *
 *   502 on cdn.frontaliereticino.ch/assets|data           -> origin R2
 *   502 on frontaliereticino.ch/commit-hash.txt, /fonts/  -> origin GitHub Pages
 *   503 on frontaliereticino.ch/{en,de,fr}/…              -> Worker -> per-locale Pages shard
 *
 * The cost of that conflation is concrete: `serve_stale`, applied to the CDN rule only, was
 * taken to mitigate #5082 too — which is a 503 on the apex and could never be touched by it.
 * Closing it "because the 5xx went down" would have filed away a defect nobody diagnosed.
 *
 * The partition is not invented: it mirrors one-to-one the cache rules that
 * `scripts/cf-locale-failover-setup.mjs` owns on the zone, which are what actually decides
 * edge behaviour per path. If those change, this must change with them.
 */

/** R2 CDN host. Also used by cf-5xx-snapshot.mjs for per-surface reporting. */
export const CDN_HOST = 'cdn.frontaliereticino.ch';
/** Apex host. */
export const APEX_HOST = 'frontaliereticino.ch';

/**
 * Path prefixes served by the `frontaliere-locale-router` Worker to the per-locale Pages
 * shards. Same list as the `locale-shard-failover-cache` expression in
 * cf-locale-failover-setup.mjs — a locale added there must be added here.
 */
export const LOCALE_SHARD_PREFIXES = ['/en/', '/de/', '/fr/'];
/** Exact shard root paths, from the expression of that same rule. */
export const LOCALE_SHARD_EXACT = new Set(['/en', '/de', '/fr', '/en.html', '/de.html', '/fr.html']);

/**
 * The surfaces. `origin` is the field that matters for diagnosis: it says WHO failed to
 * answer, which is exactly the information the `cloudflare-5xx` label erased.
 */
export const SURFACES = {
  'cdn-r2': {
    origin: 'Cloudflare R2',
    cacheRule: 'cdn-r2-passthrough-cache',
    /** serve_stale is live here since 2026-08-05 (#5158). */
    serveStale: true,
  },
  'worker-shard': {
    origin: 'frontaliere-locale-router Worker -> per-locale GitHub Pages shard',
    cacheRule: 'locale-shard-failover-cache',
    serveStale: false,
  },
  'apex-pages': {
    origin: 'GitHub Pages (apex, passthrough)',
    cacheRule: 'it-apex-html-cache',
    serveStale: false,
  },
  'www-redirect': { origin: 'www -> apex redirect', cacheRule: null, serveStale: false },
  other: { origin: 'unknown', cacheRule: null, serveStale: false },
};

/** @typedef {'cdn-r2'|'worker-shard'|'apex-pages'|'www-redirect'|'other'} SurfaceKey */

/**
 * Classify a request into the surface that served it.
 *
 * Deliberately keyed on (host, path) and nothing else: those are the only two dimensions the
 * edge itself decides on, so the classification cannot drift from real behaviour.
 *
 * `path` may be absent (the hourly diagnostics query does not group by it — see
 * fetchErrorDiagnostics). In that case an apex host is genuinely undecidable between shard and
 * Pages, and this returns `apex-unknown` instead of guessing: defaulting to `apex-pages` would
 * attribute the shard 503s to the wrong surface, i.e. reproduce the exact mistake this module
 * exists to prevent.
 *
 * @param {{host?: string|null, path?: string|null}} row
 * @returns {SurfaceKey|'apex-unknown'}
 */
export function classifySurface(row) {
  const host = String(row?.host ?? '').toLowerCase().trim();
  if (!host) return 'other';
  if (host === CDN_HOST) return 'cdn-r2';
  if (host.startsWith('www.')) return 'www-redirect';
  if (host !== APEX_HOST) return 'other';

  const path = row?.path == null ? null : String(row.path);
  if (path === '' || path === null) return 'apex-unknown';
  if (LOCALE_SHARD_EXACT.has(path)) return 'worker-shard';
  if (LOCALE_SHARD_PREFIXES.some((p) => path.startsWith(p))) return 'worker-shard';
  return 'apex-pages';
}

/**
 * A 5xx SYNTHESISED by Cloudflare: the origin returned nothing at all.
 *
 * This is the discriminator between "our origin is dead" and "our origin returned an error",
 * and the two have opposite remedies. In the adaptive dataset an origin that never answered
 * shows up as `originResponseStatus: 0`; a genuine origin error carries its own status
 * (e.g. 502-on-502, measured on this zone).
 *
 * @param {{edgeStatus?: number, originStatus?: number|null}} row
 */
export function isSynthesizedByEdge(row) {
  const edge = Number(row?.edgeStatus ?? 0);
  if (!(edge >= 500)) return false;
  const origin = row?.originStatus == null ? 0 : Number(row.originStatus);
  return origin === 0;
}

/** cacheStatus values that mean a servable copy existed at the edge. */
const CACHE_HAD_COPY = new Set(['hit', 'expired', 'revalidated', 'stale', 'updating']);

/**
 * Could serve_stale have rescued this request?
 *
 * Only if there was a cached copy to serve. A `cacheStatus` of none/miss/bypass means there
 * was nothing, so the mitigation is structurally powerless for that request no matter how
 * well the rule is configured. This is the number to watch so a mitigation that simply had no
 * material to work with is not declared a failure, and (the other way round) not declared a
 * success when the drop came from somewhere else.
 *
 * READ IT AS A SIGNAL, NOT A PROOF. Measured 2026-08-05, every CDN 502 in the window came
 * back `cache=none`, which reads as "serve_stale had nothing to serve" — but on a response
 * the edge SYNTHESISED the request may never have reached a cache-serve decision at all, so
 * `none` can also mean "the dimension is not meaningful here" rather than "no copy existed".
 * The two are not distinguishable from this dataset. What IS conclusive is the other
 * direction: if `stale`/`updating` starts appearing in the cacheStatus histogram, serve_stale
 * is demonstrably firing. Treat a persistent 0 as "unconfirmed", not as "proven inert".
 *
 * @param {{surface?: string, cacheStatus?: string|null}} row
 * @returns {boolean|null} null when the surface has no serve_stale configured
 */
export function couldServeStaleHaveHelped(row) {
  const surface = SURFACES[row?.surface];
  if (!surface || !surface.serveStale) return null;
  return CACHE_HAD_COPY.has(String(row?.cacheStatus ?? '').toLowerCase());
}
