/**
 * Cloudflare Worker — locale router for frontaliereticino.ch
 *
 * Keeps every public URL identical (frontaliereticino.ch/en/...), but serves
 * the non-primary locale subtrees from separate GitHub Pages repos so no
 * single repo trips the 10 GB Pages cap.
 *
 *   /en, /en/*, /en.html  -> origin-en.frontaliereticino.ch  (repo frontaliere-en)
 *   /de, /de/*, /de.html  -> origin-de.frontaliereticino.ch  (repo frontaliere-de)
 *   /fr, /fr/*, /fr.html  -> origin-fr.frontaliereticino.ch  (repo frontaliere-fr)
 *   everything else        -> default Pages origin (IT) passthrough
 *
 * The origin-* subdomains are DNS-only (gray-cloud) GitHub Pages custom
 * domains, reachable only from this Worker — never exposed to users. The Host
 * the user sees never changes; only the upstream fetch target's hostname is
 * rewritten. Because the fetch target URL carries the origin-* host, Cloudflare
 * sends `Host: origin-{loc}.frontaliereticino.ch` upstream, which is what makes
 * GitHub Pages match the shard repo's custom domain.
 *
 * Caching: shard responses are cached by Cloudflare's NATIVE edge cache via
 * `cf: { cacheEverything, cacheTtl }` on the origin fetch — keyed on the
 * origin-{loc} URL, tiered across colos.
 *
 * Cache API (caches.default): apex-keyed. WRITTEN on every happy-path shard
 * 200 (below); READ only when the origin fails (5xx / timeout / network) to
 * serve a stale copy — see serveStaleOnError + the cache.match() note below.
 * The stored copy does double duty: (1) stale-if-error (serve last-good 200
 * instead of propagating an origin 5xx to crawlers/users), and (2) the over-cap
 * fail-open path on the free plan — when the daily cap is exceeded and the
 * route is configured `request_limit_fail_open: true`, Cloudflare bypasses the
 * Worker and the request flows through the normal CDN pipeline, which finds
 * this apex-keyed copy (a zone Cache Rule marks /en|/de|/fr eligible for cache
 * lookup — see scripts/cf-locale-failover-setup.mjs, re-run by deploy-worker.yml
 * after every deploy). A routed Worker is invoked on EVERY matching request —
 * the edge cache cannot answer in front of it ("Workers run before the cache")
 * — so this never reduces invocation count; it only changes WHAT is served on
 * error (last-good 200 vs an error page).
 *
 * Cache API history (#1791/#1814/#1830/#1842): every Cache API op is logged in
 * zone analytics as a synthetic `requestSource: edgeWorkerCacheAPI` row —
 * cache.match() MISSes as phantom 504s (misread as an outage, three PR cycles
 * burned) and cache.put()s as 204s. This Worker therefore: (a) calls
 * cache.match() ONLY on the origin-error path (serveStaleOnError), never on the
 * happy path — there the origin has already failed, so there is no live origin
 * body to tee: the request path stays single-consumer and the #1791 deadlock
 * class (a slow eyeball consumer stalling a tee'd cache branch) remains
 * structurally impossible; the happy-path put copy is likewise built from an
 * explicit arrayBuffer, not a stream tee. The extra phantom-504 match rows are
 * bounded by the origin failure rate (~0.02%, ~50/day zone-wide) and filtered
 * out by the `requestSource: "eyeball"` monitoring since #1842
 * (scripts/lib/cf-analytics.mjs); (b) tolerates the returning 204 put rows for
 * the same reason. Keep both properties when touching this.
 *
 * Asset/data/og refs in shard HTML are CDN-absolute (since #1665), so those
 * requests bypass this Worker entirely.
 *
 *   /rss-en.xml, /sitemap-*  -> tiny root files kept in the main repo (passthrough)
 */

const SHARD_ORIGIN = {
  en: 'origin-en.frontaliereticino.ch',
  de: 'origin-de.frontaliereticino.ch',
  fr: 'origin-fr.frontaliereticino.ch',
};

// First path segment must be exactly en|de|fr, followed by end, slash, or the
// .html locale-homepage file. Anything like /rss-en.xml or /enterprise stays
// on the main origin. (The Cloudflare route patterns already scope the Worker
// to these prefixes; this regex is the in-code guard.)
const LOCALE_RE = /^\/(en|de|fr)(\/|$|\.html$)/;

// Job-alert one-click unsubscribe proxy (RFC 8058). The unsubscribe links and
// the List-Unsubscribe header in job-alert emails (scripts/send-job-alerts.mjs)
// MUST live on the sending domain (frontaliereticino.ch) or the URL↔From-domain
// mismatch trips spam filters. The actual handler is the jobAlertUnsubscribe
// Cloud Function; this Worker transparently proxies the apex path to it so the
// public URL never leaves the apex. The proxy preserves method + query + body so
// the List-Unsubscribe-Post one-click POST reaches the function unchanged (a 301
// would not be re-issued as a POST by mail clients). Tiny volume (a few
// clicks/day); never cached (stateful, and links always carry a query string so
// the it-apex-html-cache rule — query eq "" only — never matches anyway).
const UNSUB_PROXY_PATH = '/disiscrivi-alert';
const UNSUB_FUNCTION_ORIGIN =
  'https://europe-west6-frontaliere-ticino.cloudfunctions.net/jobAlertUnsubscribe';

function isUnsubProxyPath(pathname) {
  return pathname === UNSUB_PROXY_PATH || pathname === `${UNSUB_PROXY_PATH}/`;
}

// Edge-cache TTLs for shard pages. Two layers, deliberately different:
//
//   ORIGIN_CACHE_TTL (2h) — `cf.cacheTtl` on the origin fetch: CF caches the
//   ORIGIN response (tiered/cross-colo) so repeat misses don't re-contact
//   GitHub Pages. Kept at 2h because with cacheEverything it also negative-
//   caches origin 404s: a page that flips 404→200 on deploy may serve a
//   cached 404 from an already-probed colo for up to this TTL, and deploys
//   land 2-3×/day — 2h bounds that staleness window.
//
//   CACHE_MAX_AGE (6h) — `max-age`/`s-maxage` stamped on the 200 responses we
//   return. CORRECTION (2026-06-11, vs the #1865 rationale): this does NOT
//   stop re-invocations — a routed Worker runs before the cache on every
//   request (confirmed by docs and by flat invocation counts post-#1865). It
//   still helps browsers and downstream proxies hold the page, and it is the
//   Cache-Control crawl-side fetchers see.
//   Safe against stale-HTML 404s: superseded CDN asset hashes are retained
//   GRACE_DAYS=7 (prune-cdn-assets.mjs), far longer than this TTL, so HTML
//   served up to 6h stale still resolves every referenced /assets hash. Live
//   job data is client-fetched fresh from the CDN at runtime (not baked into
//   this cached HTML), so a 6h-stale SEO shell is fine.
//
//   FAIL_OPEN_CACHE_TTL (24h) — s-maxage on the apex-keyed cache.put copy:
//   how long the fail-open path can serve a page once the Worker is over the
//   daily cap. 24h spans the worst case (cap hit right after a put, reset at
//   00:00 UTC). Staleness is bounded by the same CDN-asset GRACE_DAYS=7
//   argument above. Browser max-age stays short (300) so humans who get a
//   fail-open HIT revalidate soon after.
const CACHE_MAX_AGE = 21600; // 6 h — eyeball-side (Worker response)
const ORIGIN_CACHE_TTL = 7200; // 2 h — origin-fetch side (cf.cacheTtl)
const FAIL_OPEN_CACHE_TTL = 86400; // 24 h — apex-keyed Cache API copy (fail-open failover)

// Cache-Control stamped on shard 404s. ~51k/day of shard traffic is crawlers
// re-fetching DEAD job URLs from memory (old canton/slug variants, pruned
// jobs) — 404 is the correct status (no page can exist for them: the
// traffic-evidence gate caps soft-landing emission, and 391k bridge pages
// would blow the Pages 10 GB cap), but without Cache-Control every repeat hit
// re-invokes the Worker. s-maxage lets the edge absorb repeats; short
// browser max-age so a human who lands on a just-published URL that
// transiently 404'd retries fresh soon after.
const NOT_FOUND_CACHE_CONTROL = 'public, max-age=300, s-maxage=7200';

// Canton-drift 404 recovery — real HTTP 301 (upgrade of the soft-404+JS path).
//
// A job slug is globally unique, but the canton (URL section) was re-derived
// every crawl, so the same slug migrated between sections and the previously-
// indexed URL orphaned → 404. public/404.html already recovers these at request
// time (look the slug up in /job-canon/<shard>.json, then `location.replace`),
// but that is a soft-404: GitHub Pages serves the orphan with HTTP 404 and only
// the JS does the redirect, so Google may not pass full link equity. For the
// en/de/fr shard traffic this Worker already sees, we can do better: on a shard-
// origin 404 for a job-detail path whose slug IS in the map (a confirmed orphan
// with a real canonical 200 page), respond with a genuine HTTP 301 → full equity
// transfer, no JS round-trip. (Scope: only known slugs get a 301 — an unknown/
// expired slug, or a freshly-published URL that 404'd transiently, falls through
// to the existing 404 + 404.html JS soft-fallback, so we never PERMANENTLY
// redirect a path we can't confirm. IT traffic is not routed through this Worker
// and keeps the soft path — see wrangler.toml.)
//
// The slug→{locale: section-prefix} map is emitted at the IT dist root
// (jobCanonRedirectMapPlugin → /job-canon/<shard>.json) and fetched here from the
// public apex; that path is outside the Worker's locale routes, so the subrequest
// flows straight to the IT Pages origin (no Worker re-entry) and is edge-cached
// (cacheEverything + cacheTtl) so repeat 404s for the same shard don't re-hit the
// origin. Best-effort throughout: any miss/timeout/parse error returns null and
// the normal 404 path runs.
//
// LOCALE-AWARE (do NOT collapse): the slug segment is IDENTICAL across all 4
// locales — only the section prefix is localized. The map value is therefore a
// per-locale object `{ it, en, de, fr }`; we look up the prefix for the REQUEST's
// own locale. A bare string value (legacy IT-only map, e.g. served during a
// deploy window where the new Worker runs against a not-yet-rebuilt map) or a
// missing per-locale prefix returns null → soft 404, so the Worker NEVER issues a
// permanent 301 that crosses locales (which would de-index the localized canonical
// and is far worse than the soft-404 it replaces).
//
// Matching MIRRORS public/404.html (jobRe + shard key) and jobCanonRedirectMapPlugin
// (shard key). It is duplicated, not imported: this Worker is a standalone runtime
// deployed by wrangler, not part of the Vite bundle, so it cannot share the TS
// build-plugin modules. Keep the three copies in lockstep when touching any one.
const JOB_DETAIL_RE =
  /^(?:\/(?:en|de|fr))?\/(?:cerca-lavoro|find-jobs|jobs-im|jobs-in|trouver-emploi|job-search|jobsuche|recherche-emploi)-[a-z-]+\/([^/]+)\/?$/;
const MAP_FETCH_TIMEOUT_MS = 2000;
const JOB_CANON_CACHE_TTL = 21600; // 6 h — map changes only on deploy

// Shard key for /job-canon/<sk>.json. MIRRORS public/404.html + the plugin's
// shardKey(): first 2 chars of the lowercased slug, non-alphanumerics → '_',
// padded to length 2.
function jobCanonShardKey(slug) {
  let sk = slug.slice(0, 2).replace(/[^a-z0-9]/g, '_');
  if (sk.length < 2) sk = (sk + '__').slice(0, 2);
  return sk;
}

// Returns a 301 Response to the slug's current canonical page when the requested
// path is a job-detail orphan whose slug is in the map (with a prefix for the
// request's `locale`) AND the canonical differs from the requested path;
// otherwise null (caller serves the normal 404). `locale` is the request's locale
// (en|de|fr) so the 301 stays within-locale, never cross-locale to IT.
async function recoverCantonDriftOrphan(url, locale) {
  const m = url.pathname.match(JOB_DETAIL_RE);
  if (!m) return null;
  let slug;
  try {
    slug = decodeURIComponent(m[1]).toLowerCase();
  } catch {
    slug = m[1].toLowerCase(); // malformed %-escape → use raw segment
  }
  const sk = jobCanonShardKey(slug);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAP_FETCH_TIMEOUT_MS);
  let map;
  try {
    const mapUrl = new URL(`/job-canon/${sk}.json`, url.origin);
    const resp = await fetch(mapUrl.toString(), {
      signal: controller.signal,
      cf: { cacheEverything: true, cacheTtl: JOB_CANON_CACHE_TTL },
    });
    if (!resp.ok) return null;
    map = await resp.json();
  } catch {
    return null; // miss / timeout / parse error → fall through to the 404
  } finally {
    clearTimeout(timer);
  }

  const entry = map && map[slug];
  // Per-locale object only: a legacy string value (IT-only map from a stale
  // deploy) or a missing per-locale prefix → null, so we never 301 cross-locale.
  if (!entry || typeof entry !== 'object') return null;
  const prefix = entry[locale];
  if (!prefix) return null; // unknown/expired slug for this locale → soft 404 fallback
  const canonical = `${prefix}/${slug}/`;
  // Never 301 to the path we are already on (avoids a redirect loop).
  if (canonical === url.pathname.replace(/\/+$/, '') + '/') return null;

  const location = canonical + url.search + url.hash;
  return new Response(null, {
    status: 301,
    headers: { Location: location, 'Cache-Control': NOT_FOUND_CACHE_CONTROL },
  });
}

// Per-attempt upstream timeout + one retry. A healthy shard origin answers in
// ~0.1-0.2s, so 6s is generous for a slow-but-ok fetch yet fails a hung
// connection fast; 6s×2=12s stays comfortably under Cloudflare's gateway
// timeout so our graceful 503 path can run. Measured (2026-06-11): origin
// fetches succeed first-try (~zero retries — Worker subrequests/day ≈
// cache-miss invocations/day), so this is a safety net, not a hot path.
const ORIGIN_TIMEOUT_MS = 6000;
const ORIGIN_RETRIES = 1; // total attempts = ORIGIN_RETRIES + 1

// Single upstream attempt bounded by an AbortController timeout. `cfOpts`
// carries the cf-native caching directives for shard fetches (tiered edge
// cache keyed on the upstream origin-{loc} URL — unique per locale+path, so
// locales can never collide). NOTE: do not add `cf.cacheKey` — custom cache
// keys are Enterprise-only and would be silently ignored or rejected.
async function fetchOriginOnce(upstream, request, cfOpts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORIGIN_TIMEOUT_MS);
  try {
    return await fetch(new Request(upstream, request), {
      signal: controller.signal,
      ...(cfOpts ? { cf: cfOpts } : {}),
    });
  } finally {
    clearTimeout(timer);
  }
}

// Fetch the shard origin with one retry. Retries only on a thrown error
// (timeout/network) or a 5xx — a 4xx (e.g. a real Pages 404) is returned as-is.
// Throws only if every attempt threw.
async function fetchOriginWithRetry(upstream, request, cfOpts) {
  let lastErr;
  for (let attempt = 0; attempt <= ORIGIN_RETRIES; attempt++) {
    try {
      const resp = await fetchOriginOnce(upstream, request, cfOpts);
      if (resp.status < 500 || attempt === ORIGIN_RETRIES) return resp;
    } catch (err) {
      lastErr = err;
      if (attempt === ORIGIN_RETRIES) throw err;
    }
  }
  throw lastErr;
}

// Stale-if-error. When the shard origin fails (5xx after retries, or a thrown
// timeout/network error), serve the last-good apex-keyed copy that the happy
// path stored in caches.default — instead of propagating the error to a
// crawler (SEO) or user (revenue). This is the ONLY place the Worker reads the
// Cache API; the header cache.match() note explains why doing so here is free
// of the #1791 deadlock class (no live origin body to tee on the error path).
//
// "while-revalidate" half: the returned copy carries short Cache-Control so it
// is re-checked soon, and because the Worker runs on every request the NEXT
// request re-fetches the origin and, on recovery, re-stores a fresh copy via
// the happy-path cache.put — no explicit background revalidation needed.
//
// Returns a 200 Response on HIT, or null on MISS / cache error so the caller
// falls back to surfacing the origin error. Only meaningful for GET (the cache
// holds GET 200s); callers guard on method.
async function serveStaleOnError(url, reason) {
  try {
    const cached = await caches.default.match(
      new Request(url.toString(), { method: 'GET' }),
    );
    if (cached) {
      const headers = new Headers(cached.headers);
      // Short TTLs: a stale page must be re-checked soon, not held for hours.
      headers.set('Cache-Control', 'public, max-age=60, s-maxage=120');
      headers.set('X-Served-Stale', reason);
      return new Response(cached.body, { status: 200, statusText: 'OK', headers });
    }
  } catch {
    // caches.default unavailable / match threw — treat as a MISS.
  }
  return null;
}

export default {
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);

    // Job-alert one-click unsubscribe: transparently proxy to the
    // jobAlertUnsubscribe Cloud Function, preserving method + query + body so the
    // RFC 8058 one-click POST works and the public URL stays on the sending
    // domain. Runs BEFORE the locale logic (this path is not a locale prefix, so
    // it would otherwise fall through to the apex passthrough → GitHub Pages 404).
    if (isUnsubProxyPath(url.pathname)) {
      const upstream = new URL(UNSUB_FUNCTION_ORIGIN);
      upstream.search = url.search; // carry alertId/email/token/action
      try {
        // new Request(url, request) copies method/headers/body; the upstream host
        // comes from `url` (the Cloud Function ignores the forwarded Host).
        return await fetch(new Request(upstream.toString(), request));
      } catch {
        return new Response('Unsubscribe service temporarily unavailable', {
          status: 503,
          headers: { 'Retry-After': '30' },
        });
      }
    }

    const match = url.pathname.match(LOCALE_RE);

    if (!match) {
      // IT + shared (sitemaps, robots, rss, favicon, /...) — passthrough.
      // DEFENSIVE / CURRENTLY UNREACHABLE: wrangler.toml scopes the Worker to
      // locale routes only (/en, /de, /fr) so IT traffic bypasses the Worker
      // entirely as a pure CF passthrough and never reaches this branch.  The
      // timeout+retry guard mirrors the shard-origin layer and is ready if the
      // route scope is ever expanded to cover IT traffic. No cf caching opts:
      // IT passthrough must respect the zone's own cache rules.
      try {
        return await fetchOriginWithRetry(url, request);
      } catch {
        return new Response('Origin unavailable', { status: 503 });
      }
    }

    const origin = SHARD_ORIGIN[match[1]];
    const upstream = new URL(request.url);
    upstream.hostname = origin; // rewrite Host only; path + query preserved

    let resp;
    try {
      resp = await fetchOriginWithRetry(upstream, request, {
        cacheEverything: true,
        cacheTtl: ORIGIN_CACHE_TTL,
      });
    } catch {
      // Every attempt timed out / threw — no origin response. Prefer a last-good
      // stale copy (stale-if-error) over an error page. Short Retry-After:
      // measured failure rate at this layer is ~0.02% (50×503/day zone-wide),
      // and CF's tiered cache absorbs repeats, so a transient blip self-heals.
      if (request.method === 'GET') {
        const stale = await serveStaleOnError(url, 'origin-timeout');
        if (stale) return stale;
      }
      return new Response('Shard origin unavailable', {
        status: 503,
        headers: { 'Retry-After': '30' },
      });
    }

    // Stale-if-error: origin answered but with a 5xx after retries. Serve the
    // last-good cached copy instead of propagating the error to crawler/user.
    // Falls through to return the 5xx as-is on a cache MISS.
    if (request.method === 'GET' && resp.status >= 500) {
      const stale = await serveStaleOnError(url, `origin-${resp.status}`);
      if (stale) return stale;
    }

    // GitHub Pages 301s a dir path without trailing slash (e.g. /en/lavoro ->
    // /en/lavoro/). If that Location is absolute on the hidden origin host, the
    // browser would jump to origin-{loc}.frontaliereticino.ch — exposing the
    // origin and changing the visible URL. Rewrite any such Location back to the
    // public apex so the user never leaves frontaliereticino.ch. (Indexed paths
    // use trailing-slash canonicals → 200, no redirect; this covers the edge.)
    const loc = resp.headers.get('location');
    if (loc) {
      let locUrl = null;
      try {
        locUrl = new URL(loc, upstream); // resolves relative Locations too
      } catch {
        locUrl = null; // non-URL Location header → leave untouched
      }
      if (locUrl && locUrl.hostname === origin) {
        locUrl.hostname = url.hostname; // public apex
        const headers = new Headers(resp.headers);
        headers.set('location', locUrl.toString());
        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers,
        });
      }
    }

    // Stamp Cache-Control on successful GETs, and store an APEX-KEYED copy in
    // the colo cache for the over-cap fail-open path (see header comment).
    // The body is buffered ONCE via arrayBuffer and reused for both responses
    // — deliberately no resp.clone()/stream tee, which is the #1791/#1814
    // deadlock class (a slow eyeball consumer stalls the cache.put branch).
    // Shard pages are small HTML (~50-200KB), well within Worker memory.
    // Query-string URLs are skipped: not canonical, would only pollute the
    // per-colo cache (e.g. deploy-worker.yml's ?dwcheck= cache-busters).
    if (request.method === 'GET' && resp.status === 200) {
      const headers = new Headers(resp.headers);
      headers.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE}, s-maxage=${CACHE_MAX_AGE}`);
      const body = await resp.arrayBuffer();
      if (ctx && !url.search) {
        const cacheHeaders = new Headers(resp.headers);
        cacheHeaders.set('Cache-Control', `public, max-age=300, s-maxage=${FAIL_OPEN_CACHE_TTL}`);
        ctx.waitUntil(
          caches.default
            .put(
              new Request(url.toString(), { method: 'GET' }),
              new Response(body, { status: 200, statusText: resp.statusText, headers: cacheHeaders }),
            )
            .catch(() => {}), // best-effort failover warmup — never fail the live response
        );
      }
      return new Response(body, { status: 200, statusText: resp.statusText, headers });
    }

    // Canton-drift recovery: upgrade a job-detail orphan 404 with a known slug
    // to a real HTTP 301 (full link-equity transfer) instead of the soft-404+JS
    // redirect. Unknown slugs fall through to the soft 404 below. See
    // recoverCantonDriftOrphan / NOT_FOUND_CACHE_CONTROL.
    if (request.method === 'GET' && resp.status === 404) {
      // match[1] is the request's locale (en|de|fr) — keep the 301 within-locale.
      const redirect = await recoverCantonDriftOrphan(url, match[1]);
      if (redirect) return redirect;
    }

    // Stamp Cache-Control on 404s too: see NOT_FOUND_CACHE_CONTROL. GitHub
    // Pages sends no Cache-Control on its 404 page, so without this every
    // crawler re-fetch of a dead URL re-invokes the Worker.
    if (request.method === 'GET' && resp.status === 404) {
      const headers = new Headers(resp.headers);
      headers.set('Cache-Control', NOT_FOUND_CACHE_CONTROL);
      return new Response(resp.body, { status: 404, statusText: resp.statusText, headers });
    }

    return resp;
  },
};
