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

// Ticino-section shards — ONE Pages repo PER LOCALE (frontaliere-ticino-<loc>).
// The Ticino job section is the single largest subtree in the build: ~4.2 GB /
// ~222k pages in IT alone (the cross-canton bridge mirrors essentially every
// active CH job under the legacy TI section), and the bridge runs independently
// in every locale, so en/de/fr each carry a comparably large Ticino mirror.
// A SINGLE combined repo would therefore be ~16 GB — over the 10 GB Pages cap
// itself — so each locale's Ticino subtree gets its OWN ~4 GB shard repo, served
// from origin-ticino-<loc>.frontaliereticino.ch. This keeps the IT apex AND every
// en/de/fr locale shard under the actions/deploy-pages 10 GB hard cap (the limit
// that failed the 2026-06-30 IT deploy: "total size is less than 10GB"). Routing
// it through the Worker is fine on Workers Paid (10M req/mo, overage ~$0.30/M).
//   it → /cerca-lavoro-ticino/**        de → /de/jobs-im-tessin/**
//   en → /en/find-jobs-ticino/**        fr → /fr/trouver-emploi-tessin/**
const TICINO_ORIGIN = {
  it: 'origin-ticino-it.frontaliereticino.ch',
  en: 'origin-ticino-en.frontaliereticino.ch',
  de: 'origin-ticino-de.frontaliereticino.ch',
  fr: 'origin-ticino-fr.frontaliereticino.ch',
};

// Ticino-section path prefixes → which locale's shard + 404-recovery to use.
// Matched BEFORE LOCALE_RE so an /en|/de|/fr Ticino path resolves to its Ticino
// shard, not origin-{loc}. The IT prefix (/cerca-lavoro-ticino) is newly routed
// through the Worker via dedicated wrangler routes (the apex bypasses the Worker
// for everything else); the three localized prefixes already reach the Worker
// under the existing /en|/de|/fr routes, so matchTicino re-targets them in-code.
const TICINO_ROUTES = [
  { prefix: '/cerca-lavoro-ticino', locale: 'it' },
  { prefix: '/en/find-jobs-ticino', locale: 'en' },
  { prefix: '/de/jobs-im-tessin', locale: 'de' },
  { prefix: '/fr/trouver-emploi-tessin', locale: 'fr' },
];

// Returns the matching TICINO_ROUTES entry (with its locale) when the path is the
// Ticino section root, the .html flat root, or anything under it; null otherwise.
// Anchored so a look-alike section like /cerca-lavoro-ticino-altro never matches.
function matchTicino(pathname) {
  for (const route of TICINO_ROUTES) {
    if (
      pathname === route.prefix ||
      pathname === `${route.prefix}.html` ||
      pathname.startsWith(`${route.prefix}/`)
    ) {
      return route;
    }
  }
  return null;
}

// First path segment must be exactly en|de|fr, followed by end, slash, or the
// .html locale-homepage file. Anything like /rss-en.xml or /enterprise stays
// on the main origin. (The Cloudflare route patterns already scope the Worker
// to these prefixes; this regex is the in-code guard.)
const LOCALE_RE = /^\/(en|de|fr)(\/|$|\.html$)/;

// One-click unsubscribe proxies (RFC 8058). The unsubscribe links and the
// List-Unsubscribe header in our emails (job-alert: scripts/send-job-alerts.mjs;
// cold-outreach: scripts/send-cold-emails.mjs) MUST live on the sending domain
// (frontaliereticino.ch) or the URL↔From-domain mismatch trips spam filters. The
// actual handlers are the jobAlertUnsubscribe / outreachUnsubscribe Cloud
// Functions; this Worker transparently proxies each apex path to its function so
// the public URL never leaves the apex. The proxy preserves method + query +
// body so the List-Unsubscribe-Post one-click POST reaches the function
// unchanged (a 301 would not be re-issued as a POST by mail clients). Tiny
// volume (a few clicks/day); never cached (stateful, and links always carry a
// query string so the it-apex-html-cache rule — query eq "" only — never
// matches anyway).
const CF_FN_BASE = 'https://europe-west6-frontaliere-ticino.cloudfunctions.net';
const UNSUB_PROXIES = {
  '/disiscrivi-alert': `${CF_FN_BASE}/jobAlertUnsubscribe`,
  '/disiscrivi-outreach': `${CF_FN_BASE}/outreachUnsubscribe`,
  '/disiscrivi-newsletter': `${CF_FN_BASE}/newsletterManageSubscription`,
};

// Returns the upstream Cloud Function origin for an unsubscribe path (bare or
// trailing-slash form), or null if the path is not a registered proxy.
function unsubProxyOrigin(pathname) {
  for (const [base, origin] of Object.entries(UNSUB_PROXIES)) {
    if (pathname === base || pathname === `${base}/`) return origin;
  }
  return null;
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
// The slug→{locale: section-prefix} map is emitted by jobCanonRedirectMapPlugin
// and pushed to cdn.frontaliereticino.ch/job-canon/<shard>.json (CDN-offloaded,
// same as /data and /og — see deploy-it-pages-prep.sh step_push_cdn). Fetched
// here as a plain cross-origin subrequest (Workers fetch() is not CORS-bound,
// unlike public/404.html's browser-context fetch) and edge-cached (cacheEverything
// + cacheTtl) so repeat 404s for the same shard don't re-hit the CDN. Best-effort
// throughout: any miss/timeout/parse error returns null and the normal 404 path
// runs.
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

// Cross-locale company-hub prefix recovery (see recoverCrossLocaleCompanyPrefix).
// Company-hub URLs carry a LOCALIZED prefix on the last path segment:
//   IT azienda-   EN company-   DE unternehmen-   FR entreprise-
// The build emits each locale's hub ONLY under that locale's prefix, so a hub
// requested with a foreign prefix (e.g. the IT `azienda-` kept on an /fr route)
// is a hard origin 404. COMPANY_HUB_RE captures the locale-route prefix and the
// last segment generically; the prefix alternation lives ONLY in
// COMPANY_PREFIX_RE (single source of truth, no literal re-duplication).
const COMPANY_PREFIX_BY_LOCALE = { en: 'company', de: 'unternehmen', fr: 'entreprise' };
const COMPANY_PREFIX_RE = /^(?:azienda|company|unternehmen|entreprise)-(.+)$/;
const COMPANY_HUB_RE =
  /^(\/(?:en|de|fr)\/(?:cerca-lavoro|find-jobs|jobs-im|jobs-in|trouver-emploi|job-search|jobsuche|recherche-emploi)-[a-z-]+)\/([^/]+)\/?$/;

// Generative fallback for legacy related-search CLUSTER orphans (last segment is
// a search-action slug `ricerca-/search-/suche-/recherche-…`). These came from an
// old per-canton slug format (`/cerca-lavoro-<canton>/ricerca-<role>-svizzera/`)
// that was migrated to `/cerca-lavoro-svizzera/ricerca-<role>-<city>/`. The KNOWN
// ones (from the GSC snapshot) are already recovered as 200 compat-bridge pages,
// but Google indexed many more than our snapshot captured, so the long tail still
// soft-404s. We cannot enumerate the unknown ones for a SPECIFIC target, so we
// 301 them to the locale's NATIONAL job board — always a live 200 page, never a
// 301→404 (a canton-section root would 404 on an odd/fake canton slug). The board
// is the nationalized cluster's natural home and keeps the job-search intent.
const SEARCH_CLUSTER_PREFIX_RE = /^(?:ricerca|search|suche|recherche)-/;
const NATIONAL_BOARD_BY_LOCALE = {
  en: '/en/find-jobs-switzerland/',
  de: '/de/jobs-in-schweiz/',
  fr: '/fr/trouver-emploi-suisse/',
};

// Legacy listing-pagination recovery. The old listing URL format
//   /<locale>/<section>-<canton>/<filter>/page-<N>/   (filter ∈ the "all jobs"
// word per locale: tutte/tutti · alle · tous/toutes · all) was retired; every
// `/page-N/` now hard-404s on origin (verified live — even page-1). These are
// real legacy listing pages (Google indexed the deep pagination), and the canton
// section root is always a live 200, so it is the correct topical home. We 301
// there (real link-equity transfer) instead of leaving the soft-404, which the
// SPA fallback MIS-recovered to the homepage: public/404.html's job-detail jobRe
// matches only a SINGLE trailing segment, so the multi-segment pagination path
// fell through to spaRedirect('/'). The `/page-\d+/` + known-filter shape is
// specific enough that fake/garbage cantons effectively never reach here (those
// are scanner noise on shallow paths), so the canton-root target is safe (no
// 301→404). Group 1 captures the section root. MIRRORS public/404.html pagRe.
const LEGACY_PAGINATION_RE =
  /^((?:\/(?:en|de|fr))?\/(?:cerca-lavoro|find-jobs|jobs-im|jobs-in|trouver-emploi|job-search|jobsuche|recherche-emploi)-[a-z-]+)\/(?:tutte|tutti|alle|tous|toutes|all)\/page-\d+\/?$/;

// Canton-root-validity guard (#3015, follow-up of #3001's "Non implementato").
//
// Two 404 shapes were left on the soft-404 (public/404.html client JS) path
// instead of a real 301: (a) a company-hub orphan whose locale prefix is
// ALREADY correct but the hub itself was pruned from the build (company no
// longer listed — recoverCrossLocaleCompanyPrefix's "already canonical" loop
// guard intentionally no-ops here, there is no prefix to fix), and (b) a
// job-detail 404 whose slug is genuinely expired (not a canton-drift — the
// slug is simply not in /job-canon at all, so recoverCantonDriftOrphan misses).
// Both cases fall back to the canton SECTION ROOT — the same target
// public/404.html's JS already redirects to (its `sectionRoot` variable) — so
// upgrading to a real 301 is a pure link-equity win IF the target is live.
//
// Unlike the map-verified recoverCantonDriftOrphan (the map only contains
// slugs confirmed live at build time) or recoverLegacySearchCluster's fixed
// per-locale NATIONAL_BOARD literal (never derived from the request, so it
// cannot dead-end), the section-root path here is DERIVED from free-form URL
// segments ([a-z-]+ in both COMPANY_HUB_RE and JOB_DETAIL_RE has no canton
// allowlist) with no prior verification — a garbage/fake canton segment would
// 301 into a dead end. So: verify with a subrequest before redirecting; a
// miss/non-200/timeout returns false and the caller falls through to the
// EXISTING soft-404 (never worse than before this guard existed).
//
// Scope note (sibling-pattern-fix check, AGENTS.md #6): recoverLegacyPagination
// also derives its section-root 301 target from free-form URL segments without
// this guard — but that is a pre-existing, already-shipped, already-tested
// design from PR #3001 with its OWN documented narrowness argument ("the
// /page-\d+/ + known-filter shape is specific enough that fake/garbage cantons
// effectively never reach here") and adding the guard there breaks its
// existing test fixtures (tests/locale-router-legacy-pagination-301.test.ts
// asserts an unconditional 301 on origin-404 alone). recoverCrossLocaleCompanyPrefix
// is a deterministic same-resource prefix SWAP ("Purely synchronous... the
// prefix↔locale mapping is deterministic" — its own comment), not a
// best-guess ancestor fallback, and retrofitting the guard there likewise
// breaks tests/locale-router-xlocale-company-prefix-301.test.ts. Both are
// judged false positives for this pattern (documented, tested, pre-existing
// design distinct from the two brand-new no-narrowness fallbacks below) rather
// than left silently unfixed.
const CANTON_ROOT_GUARD_TIMEOUT_MS = 2000;

// Returns true only when `pathname` resolves to a 200 on the shard `origin`.
// GET (not HEAD) to match every other origin-fetch's caching convention in
// this file; the body is never read. Edge-cached via cacheEverything so many
// orphans that share one canton root (e.g. several pruned company hubs in the
// same canton) cost a single origin round trip. ORIGIN_CACHE_TTL (2 h) reused
// for the same reason it exists elsewhere: bounds a 404-vs-200 flip around a
// deploy without inventing a parallel TTL knob.
async function redirectTargetIsLive(pathname, origin) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CANTON_ROOT_GUARD_TIMEOUT_MS);
  try {
    const upstream = new URL(pathname, `https://${origin}`);
    const resp = await fetch(upstream.toString(), {
      signal: controller.signal,
      cf: { cacheEverything: true, cacheTtl: ORIGIN_CACHE_TTL },
    });
    return resp.status === 200;
  } catch {
    return false; // timeout / network error → unverified, safe soft-404 fallback
  } finally {
    clearTimeout(timer);
  }
}

const MAP_FETCH_TIMEOUT_MS = 2000;
const JOB_CANON_CACHE_TTL = 21600; // 6 h — map changes only on deploy
// CDN-offloaded (see comment above recoverCantonDriftOrphan). MIRRORS the
// literal in public/404.html — duplicated, not imported, same reason as
// JOB_DETAIL_RE above (standalone Worker runtime, not part of the Vite bundle).
const JOB_CANON_CDN_BASE = 'https://cdn.frontaliereticino.ch';

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
    const mapUrl = new URL(`/job-canon/${sk}.json`, JOB_CANON_CDN_BASE);
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

// Returns a within-locale 301 Response when the requested path is a company-hub
// orphaned only by a wrong-locale company prefix (e.g. the IT `azienda-` prefix
// kept on an /fr `trouver-emploi-*` route), otherwise null. The fix swaps ONLY
// the company prefix to the request locale's canonical one
// (COMPANY_PREFIX_BY_LOCALE) and leaves the rest of the path byte-identical, so
// the 301 stays strictly within-locale (never crosses to IT) and lands on the
// real 200 hub. Purely synchronous (no map/subrequest): the prefix↔locale
// mapping is deterministic. The caller runs this ONLY after the canton-drift map
// miss, so a real job-detail slug (which lives in /job-canon) is never hijacked.
function recoverCrossLocaleCompanyPrefix(url, locale) {
  const correct = COMPANY_PREFIX_BY_LOCALE[locale];
  if (!correct) return null;
  const m = url.pathname.match(COMPANY_HUB_RE);
  if (!m) return null;
  const [, routePrefix, lastSeg] = m;
  const pm = lastSeg.match(COMPANY_PREFIX_RE);
  if (!pm) return null; // last segment is not a company-prefixed hub → leave alone
  const rest = pm[1];
  // Already canonical for this locale → nothing to fix (loop guard).
  if (lastSeg === `${correct}-${rest}`) return null;
  const canonical = `${routePrefix}/${correct}-${rest}/`;
  const location = canonical + url.search + url.hash;
  return new Response(null, {
    status: 301,
    headers: { Location: location, 'Cache-Control': NOT_FOUND_CACHE_CONTROL },
  });
}

// Returns a 301 Response to the canton section root when the requested path is a
// company-hub 404 whose locale prefix is ALREADY correct (recoverCrossLocaleCompanyPrefix
// above found nothing to swap) but the hub itself is gone — a genuinely pruned
// company, not a locale mismatch (#3015 follow-up of #3001). The section root is
// the same fallback public/404.html's JS already uses for this exact case;
// guarded by redirectTargetIsLive (see its doc comment above MAP_FETCH_TIMEOUT_MS)
// because the canton segment is free-form and unverified until now. Runs ONLY
// after the map miss and the cross-locale-prefix miss, so a real job slug or a
// fixable wrong-prefix hub is never hijacked.
async function recoverPrunedCompanyHub(url, locale, origin) {
  const correct = COMPANY_PREFIX_BY_LOCALE[locale];
  if (!correct) return null;
  const m = url.pathname.match(COMPANY_HUB_RE);
  if (!m) return null;
  const [, routePrefix, lastSeg] = m;
  const pm = lastSeg.match(COMPANY_PREFIX_RE);
  if (!pm) return null; // last segment is not a company-prefixed hub → leave alone
  // Only the already-canonical-prefix case; a wrong prefix is handled (as a
  // deterministic same-resource swap, not a guess) by recoverCrossLocaleCompanyPrefix above.
  if (lastSeg !== `${correct}-${pm[1]}`) return null;
  const sectionRoot = `${routePrefix}/`;
  if (!(await redirectTargetIsLive(sectionRoot, origin))) return null; // unverified → soft 404
  const location = sectionRoot + url.search + url.hash;
  return new Response(null, {
    status: 301,
    headers: { Location: location, 'Cache-Control': NOT_FOUND_CACHE_CONTROL },
  });
}

// Returns a within-locale 301 Response to the locale's national job board when
// the requested path is a legacy related-search cluster orphan (last path segment
// starts with a search-action prefix — see SEARCH_CLUSTER_PREFIX_RE), otherwise
// null. Synchronous (no map/subrequest): the target is a fixed per-locale board.
// The caller runs this ONLY after the canton-drift map miss and the company-prefix
// miss, so a real job-detail slug (which lives in /job-canon) is never hijacked —
// and real job slugs do not start with `ricerca-/search-/suche-/recherche-`. The
// national board is always a live 200, so this never produces a 301→404.
function recoverLegacySearchCluster(url, locale) {
  const board = NATIONAL_BOARD_BY_LOCALE[locale];
  if (!board) return null;
  const m = url.pathname.match(JOB_DETAIL_RE);
  if (!m) return null;
  let lastSeg;
  try {
    lastSeg = decodeURIComponent(m[1]).toLowerCase();
  } catch {
    lastSeg = m[1].toLowerCase();
  }
  if (!SEARCH_CLUSTER_PREFIX_RE.test(lastSeg)) return null;
  // Already on the national board (loop guard — the board path has no extra segment).
  if (url.pathname.replace(/\/+$/, '') + '/' === board) return null;
  const location = board + url.search + url.hash;
  return new Response(null, {
    status: 301,
    headers: { Location: location, 'Cache-Control': NOT_FOUND_CACHE_CONTROL },
  });
}

// Returns a 301 Response to the canton section root when the requested path is a
// legacy listing-pagination URL (`/<section>-<canton>/<filter>/page-<N>/` — see
// LEGACY_PAGINATION_RE), otherwise null. Synchronous (no map/subrequest): the
// target is a deterministic prefix of the requested path. Locale-agnostic — the
// regex captures the full locale-routed prefix and the 301 stays within it.
function recoverLegacyPagination(url) {
  const m = url.pathname.match(LEGACY_PAGINATION_RE);
  if (!m) return null;
  const sectionRoot = `${m[1]}/`;
  // Loop guard (unreachable: the matched path always has extra segments).
  if (url.pathname.replace(/\/+$/, '') + '/' === sectionRoot) return null;
  const location = sectionRoot + url.search + url.hash;
  return new Response(null, {
    status: 301,
    headers: { Location: location, 'Cache-Control': NOT_FOUND_CACHE_CONTROL },
  });
}

// Returns a 301 Response to the canton section root when the requested path is a
// job-detail 404 whose slug is genuinely expired — NOT a canton-drift (the slug
// is simply absent from /job-canon, unlike recoverCantonDriftOrphan's known-slug
// case) — and none of the more specific recoveries above matched either (#3015
// follow-up of #3001). Mirrors public/404.html's JS last-resort `sectionRoot`
// fallback (its `.then`/`.catch` branches after the map lookup fails), upgrading
// it to a real 301 for en/de/fr shard traffic. Guarded by redirectTargetIsLive
// for the same reason as recoverPrunedCompanyHub: the canton segment is
// free-form, so an invalid/garbage section must fall through to the existing
// soft-404 instead of a 301 dead end. Runs LAST in the 404 chain — JOB_DETAIL_RE
// also matches company-hub and search-cluster shaped slugs, both already handled
// (and are more specific) above.
async function recoverExpiredJobToCantonRoot(url, origin) {
  const m = url.pathname.match(JOB_DETAIL_RE);
  if (!m) return null;
  const sectionRoot =
    url.pathname.replace(/\/+$/, '').split('/').slice(0, -1).join('/') + '/'; // mirrors public/404.html's sectionRoot
  // Loop guard (unreachable: JOB_DETAIL_RE always leaves a trailing slug segment
  // beyond the section root), kept for parity with the sibling recoveries.
  if (url.pathname.replace(/\/+$/, '') + '/' === sectionRoot) return null;
  if (!(await redirectTargetIsLive(sectionRoot, origin))) return null; // unverified → soft 404
  const location = sectionRoot + url.search + url.hash;
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

// Serve a request from a GitHub Pages shard origin (locale shard or the Ticino
// shard). Rewrites only the upstream Host to `origin` (the gray-cloud custom
// domain reachable solely from this Worker); the public URL the user sees never
// changes. Applies the full shard pipeline: tiered edge cache + one retry,
// stale-if-error from the apex-keyed Cache API, origin→apex Location rewrite,
// Cache-Control stamping, apex-keyed fail-open warmup on 200s, and the job-orphan
// 301 recoveries on 404s. `recoveryLocale` (it|en|de|fr) selects which
// within-locale recovery map/board to use — for the IT Ticino subtree it is
// 'it', so only the canton-drift map recovery (which has IT entries) can fire and
// the en/de/fr-only company/cluster/board recoveries safely no-op.
async function serveShard(request, url, origin, recoveryLocale, ctx) {
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
    // stale copy (stale-if-error) over an error page.
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
  if (request.method === 'GET' && resp.status >= 500) {
    const stale = await serveStaleOnError(url, `origin-${resp.status}`);
    if (stale) return stale;
  }

  // GitHub Pages 301s a dir path without trailing slash to the slash form. If
  // that Location is absolute on the hidden origin host, rewrite it back to the
  // public apex so the user never leaves frontaliereticino.ch and the origin
  // host is never exposed.
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

  // Stamp Cache-Control on successful GETs, and store an APEX-KEYED copy in the
  // colo cache for the over-cap/stale-if-error fail-open path. Body buffered ONCE
  // via arrayBuffer and reused — no clone()/stream tee (the #1791/#1814 deadlock
  // class). Query-string URLs are skipped: not canonical.
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

  // Canton-drift recovery: upgrade a job-detail orphan 404 with a known slug to a
  // real HTTP 301 (full link-equity transfer) instead of the soft-404+JS path.
  // Unknown slugs fall through to the soft 404 below.
  if (request.method === 'GET' && resp.status === 404) {
    const redirect = await recoverCantonDriftOrphan(url, recoveryLocale);
    if (redirect) return redirect;
    const companyRedirect = recoverCrossLocaleCompanyPrefix(url, recoveryLocale);
    if (companyRedirect) return companyRedirect;
    // #3015: already-correct-prefix company hub that was pruned from the build —
    // guarded (redirectTargetIsLive) 301 to the canton section root.
    const prunedHubRedirect = await recoverPrunedCompanyHub(url, recoveryLocale, origin);
    if (prunedHubRedirect) return prunedHubRedirect;
    const clusterRedirect = recoverLegacySearchCluster(url, recoveryLocale);
    if (clusterRedirect) return clusterRedirect;
    const paginationRedirect = recoverLegacyPagination(url);
    if (paginationRedirect) return paginationRedirect;
    // #3015: last-resort — a genuinely expired job-detail slug (not a canton
    // drift, not a company/cluster/pagination shape) — guarded 301 to the
    // canton section root, mirroring public/404.html's final sectionRoot fallback.
    const expiredJobRedirect = await recoverExpiredJobToCantonRoot(url, origin);
    if (expiredJobRedirect) return expiredJobRedirect;
  }

  // Stamp Cache-Control on 404s too so crawler re-fetches of dead URLs are
  // absorbed by the edge instead of re-invoking the Worker.
  if (request.method === 'GET' && resp.status === 404) {
    const headers = new Headers(resp.headers);
    headers.set('Cache-Control', NOT_FOUND_CACHE_CONTROL);
    return new Response(resp.body, { status: 404, statusText: resp.statusText, headers });
  }

  return resp;
}

export default {
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);

    // One-click unsubscribe (job-alert + cold-outreach): transparently proxy to
    // the matching Cloud Function, preserving method + query + body so the RFC
    // 8058 one-click POST works and the public URL stays on the sending domain.
    // Runs BEFORE the locale logic (these paths are not locale prefixes, so they
    // would otherwise fall through to the apex passthrough → GitHub Pages 404).
    const unsubOrigin = unsubProxyOrigin(url.pathname);
    if (unsubOrigin) {
      const upstream = new URL(unsubOrigin);
      upstream.search = url.search; // carry alertId/email/token/action or c/t
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

    // Ticino-section shard — checked BEFORE the locale match so an /en|/de|/fr
    // Ticino path (e.g. /en/find-jobs-ticino/...) resolves to origin-ticino, the
    // carved-out shard, instead of origin-{loc}. The IT /cerca-lavoro-ticino
    // prefix reaches the Worker via its own wrangler routes; all other IT paths
    // stay a pure apex passthrough (the !match branch below).
    const tic = matchTicino(url.pathname);
    if (tic) {
      return serveShard(request, url, TICINO_ORIGIN[tic.locale], tic.locale, ctx);
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

    // Locale shard (en|de|fr): rewrite the upstream Host to origin-{loc} and run
    // the shared shard pipeline. match[1] is the request's locale, used to keep
    // any 404→301 recovery within-locale.
    return serveShard(request, url, SHARD_ORIGIN[match[1]], match[1], ctx);
  },
};
