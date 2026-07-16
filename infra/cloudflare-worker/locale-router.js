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
 *   EXCEPT the handful of exact paths in EDGE_PUSHED_FILES below (issue #4881
 *   Fase 3) — these are served from a pushable R2 origin when a fresher copy
 *   has been PUT there by the fast-publish path, falling open to the same
 *   passthrough above on any miss/error.
 */

const SHARD_ORIGIN = {
  en: 'origin-en.frontaliereticino.ch',
  de: 'origin-de.frontaliereticino.ch',
  fr: 'origin-fr.frontaliereticino.ch',
};

// Section shards — ONE Pages repo PER LOCALE PER SECTION (frontaliere-<section>-<loc>).
// Ticino was the original carve-out (the single largest subtree in the build:
// ~4.2 GB / ~222k pages in IT alone — the cross-canton bridge mirrors essentially
// every active CH job under the legacy TI section, and the bridge runs
// independently in every locale, so en/de/fr each carry a comparably large
// Ticino mirror; a SINGLE combined repo would be ~16 GB, over the 10 GB Pages cap
// itself). The site outgrew the 10 GB actions/deploy-pages cap again, so the same
// treatment now applies to svizzera (the nationwide aggregator) and zurigo
// (Zurich canton) — each section's locale subtree gets its OWN shard repo, served
// from origin-<section>-<loc>.frontaliereticino.ch. Routing it through the Worker
// is fine on Workers Paid (10M req/mo, overage ~$0.30/M).
//
// Slug source of truth: scripts/lib/section-shard-slugs.json. This file cannot
// import it (must stay a single self-contained paste-able script — see the file
// header above), so the literal prefixes/origins below MIRROR that JSON — keep
// both in sync if a slug ever changes.
//   ticino:   it → /cerca-lavoro-ticino/**      en → /en/find-jobs-ticino/**
//             de → /de/jobs-im-tessin/**        fr → /fr/trouver-emploi-tessin/**
//   svizzera: it → /cerca-lavoro-svizzera/**    en → /en/find-jobs-switzerland/**
//             de → /de/jobs-in-schweiz/**       fr → /fr/trouver-emploi-suisse/**
//   zurigo:   it → /cerca-lavoro-zurigo/**      en → /en/find-jobs-zurich/**
//             de → /de/jobs-in-zurich/**        fr → /fr/trouver-emploi-zurich/**
const SECTION_ORIGIN = {
  ticino: {
    it: 'origin-ticino-it.frontaliereticino.ch',
    en: 'origin-ticino-en.frontaliereticino.ch',
    de: 'origin-ticino-de.frontaliereticino.ch',
    fr: 'origin-ticino-fr.frontaliereticino.ch',
  },
  svizzera: {
    it: 'origin-svizzera-it.frontaliereticino.ch',
    en: 'origin-svizzera-en.frontaliereticino.ch',
    de: 'origin-svizzera-de.frontaliereticino.ch',
    fr: 'origin-svizzera-fr.frontaliereticino.ch',
  },
  zurigo: {
    it: 'origin-zurigo-it.frontaliereticino.ch',
    en: 'origin-zurigo-en.frontaliereticino.ch',
    de: 'origin-zurigo-de.frontaliereticino.ch',
    fr: 'origin-zurigo-fr.frontaliereticino.ch',
  },
  argovia: {
    it: 'origin-argovia-it.frontaliereticino.ch',
    en: 'origin-argovia-en.frontaliereticino.ch',
    de: 'origin-argovia-de.frontaliereticino.ch',
    fr: 'origin-argovia-fr.frontaliereticino.ch',
  },
  appenzello: {
    it: 'origin-appenzello-it.frontaliereticino.ch',
    en: 'origin-appenzello-en.frontaliereticino.ch',
    de: 'origin-appenzello-de.frontaliereticino.ch',
    fr: 'origin-appenzello-fr.frontaliereticino.ch',
  },
  basilea: {
    it: 'origin-basilea-it.frontaliereticino.ch',
    en: 'origin-basilea-en.frontaliereticino.ch',
    de: 'origin-basilea-de.frontaliereticino.ch',
    fr: 'origin-basilea-fr.frontaliereticino.ch',
  },
  berna: {
    it: 'origin-berna-it.frontaliereticino.ch',
    en: 'origin-berna-en.frontaliereticino.ch',
    de: 'origin-berna-de.frontaliereticino.ch',
    fr: 'origin-berna-fr.frontaliereticino.ch',
  },
  friburgo: {
    it: 'origin-friburgo-it.frontaliereticino.ch',
    en: 'origin-friburgo-en.frontaliereticino.ch',
    de: 'origin-friburgo-de.frontaliereticino.ch',
    fr: 'origin-friburgo-fr.frontaliereticino.ch',
  },
  ginevra: {
    it: 'origin-ginevra-it.frontaliereticino.ch',
    en: 'origin-ginevra-en.frontaliereticino.ch',
    de: 'origin-ginevra-de.frontaliereticino.ch',
    fr: 'origin-ginevra-fr.frontaliereticino.ch',
  },
  glarona: {
    it: 'origin-glarona-it.frontaliereticino.ch',
    en: 'origin-glarona-en.frontaliereticino.ch',
    de: 'origin-glarona-de.frontaliereticino.ch',
    fr: 'origin-glarona-fr.frontaliereticino.ch',
  },
  grigioni: {
    it: 'origin-grigioni-it.frontaliereticino.ch',
    en: 'origin-grigioni-en.frontaliereticino.ch',
    de: 'origin-grigioni-de.frontaliereticino.ch',
    fr: 'origin-grigioni-fr.frontaliereticino.ch',
  },
  giura: {
    it: 'origin-giura-it.frontaliereticino.ch',
    en: 'origin-giura-en.frontaliereticino.ch',
    de: 'origin-giura-de.frontaliereticino.ch',
    fr: 'origin-giura-fr.frontaliereticino.ch',
  },
  lucerna: {
    it: 'origin-lucerna-it.frontaliereticino.ch',
    en: 'origin-lucerna-en.frontaliereticino.ch',
    de: 'origin-lucerna-de.frontaliereticino.ch',
    fr: 'origin-lucerna-fr.frontaliereticino.ch',
  },
  neuchatel: {
    it: 'origin-neuchatel-it.frontaliereticino.ch',
    en: 'origin-neuchatel-en.frontaliereticino.ch',
    de: 'origin-neuchatel-de.frontaliereticino.ch',
    fr: 'origin-neuchatel-fr.frontaliereticino.ch',
  },
  nidvaldo: {
    it: 'origin-nidvaldo-it.frontaliereticino.ch',
    en: 'origin-nidvaldo-en.frontaliereticino.ch',
    de: 'origin-nidvaldo-de.frontaliereticino.ch',
    fr: 'origin-nidvaldo-fr.frontaliereticino.ch',
  },
  obvaldo: {
    it: 'origin-obvaldo-it.frontaliereticino.ch',
    en: 'origin-obvaldo-en.frontaliereticino.ch',
    de: 'origin-obvaldo-de.frontaliereticino.ch',
    fr: 'origin-obvaldo-fr.frontaliereticino.ch',
  },
  sciaffusa: {
    it: 'origin-sciaffusa-it.frontaliereticino.ch',
    en: 'origin-sciaffusa-en.frontaliereticino.ch',
    de: 'origin-sciaffusa-de.frontaliereticino.ch',
    fr: 'origin-sciaffusa-fr.frontaliereticino.ch',
  },
  soletta: {
    it: 'origin-soletta-it.frontaliereticino.ch',
    en: 'origin-soletta-en.frontaliereticino.ch',
    de: 'origin-soletta-de.frontaliereticino.ch',
    fr: 'origin-soletta-fr.frontaliereticino.ch',
  },
  svitto: {
    it: 'origin-svitto-it.frontaliereticino.ch',
    en: 'origin-svitto-en.frontaliereticino.ch',
    de: 'origin-svitto-de.frontaliereticino.ch',
    fr: 'origin-svitto-fr.frontaliereticino.ch',
  },
  turgovia: {
    it: 'origin-turgovia-it.frontaliereticino.ch',
    en: 'origin-turgovia-en.frontaliereticino.ch',
    de: 'origin-turgovia-de.frontaliereticino.ch',
    fr: 'origin-turgovia-fr.frontaliereticino.ch',
  },
  uri: {
    it: 'origin-uri-it.frontaliereticino.ch',
    en: 'origin-uri-en.frontaliereticino.ch',
    de: 'origin-uri-de.frontaliereticino.ch',
    fr: 'origin-uri-fr.frontaliereticino.ch',
  },
  vaud: {
    it: 'origin-vaud-it.frontaliereticino.ch',
    en: 'origin-vaud-en.frontaliereticino.ch',
    de: 'origin-vaud-de.frontaliereticino.ch',
    fr: 'origin-vaud-fr.frontaliereticino.ch',
  },
  vallese: {
    it: 'origin-vallese-it.frontaliereticino.ch',
    en: 'origin-vallese-en.frontaliereticino.ch',
    de: 'origin-vallese-de.frontaliereticino.ch',
    fr: 'origin-vallese-fr.frontaliereticino.ch',
  },
  zugo: {
    it: 'origin-zugo-it.frontaliereticino.ch',
    en: 'origin-zugo-en.frontaliereticino.ch',
    de: 'origin-zugo-de.frontaliereticino.ch',
    fr: 'origin-zugo-fr.frontaliereticino.ch',
  },
  sangallo: {
    it: 'origin-sangallo-it.frontaliereticino.ch',
    en: 'origin-sangallo-en.frontaliereticino.ch',
    de: 'origin-sangallo-de.frontaliereticino.ch',
    fr: 'origin-sangallo-fr.frontaliereticino.ch',
  },
  articolifrontaliere: {
    it: 'origin-articolifrontaliere-it.frontaliereticino.ch',
    en: 'origin-articolifrontaliere-en.frontaliereticino.ch',
    de: 'origin-articolifrontaliere-de.frontaliereticino.ch',
    fr: 'origin-articolifrontaliere-fr.frontaliereticino.ch',
  },
  articolisvizzera: {
    it: 'origin-articolisvizzera-it.frontaliereticino.ch',
    en: 'origin-articolisvizzera-en.frontaliereticino.ch',
    de: 'origin-articolisvizzera-de.frontaliereticino.ch',
    fr: 'origin-articolisvizzera-fr.frontaliereticino.ch',
  },
};

// Section path prefixes → which section + locale's shard + 404-recovery to use.
// Matched BEFORE LOCALE_RE so an /en|/de|/fr section path resolves to its section
// shard, not origin-{loc}. Each section's IT prefix is routed through the Worker
// via a dedicated wrangler route (the apex bypasses the Worker for everything
// else); the localized prefixes already reach the Worker under the existing
// /en|/de|/fr routes, so matchSection re-targets them in-code.
// Named export (Workers runtime only ever uses the default export below —
// this is purely so tests/locale-router-section-shard.test.ts can iterate
// the real table instead of duplicating it, which would drift on the next
// section addition).
export const SECTION_ROUTES = [
  { section: 'ticino', prefix: '/cerca-lavoro-ticino', locale: 'it' },
  { section: 'ticino', prefix: '/en/find-jobs-ticino', locale: 'en' },
  { section: 'ticino', prefix: '/de/jobs-im-tessin', locale: 'de' },
  { section: 'ticino', prefix: '/fr/trouver-emploi-tessin', locale: 'fr' },
  { section: 'svizzera', prefix: '/cerca-lavoro-svizzera', locale: 'it' },
  { section: 'svizzera', prefix: '/en/find-jobs-switzerland', locale: 'en' },
  { section: 'svizzera', prefix: '/de/jobs-in-schweiz', locale: 'de' },
  { section: 'svizzera', prefix: '/fr/trouver-emploi-suisse', locale: 'fr' },
  { section: 'zurigo', prefix: '/cerca-lavoro-zurigo', locale: 'it' },
  { section: 'zurigo', prefix: '/en/find-jobs-zurich', locale: 'en' },
  { section: 'zurigo', prefix: '/de/jobs-in-zurich', locale: 'de' },
  { section: 'zurigo', prefix: '/fr/trouver-emploi-zurich', locale: 'fr' },
  { section: 'argovia', prefix: '/cerca-lavoro-argovia', locale: 'it' },
  { section: 'argovia', prefix: '/en/find-jobs-aargau', locale: 'en' },
  { section: 'argovia', prefix: '/de/jobs-im-aargau', locale: 'de' },
  { section: 'argovia', prefix: '/fr/trouver-emploi-argovie', locale: 'fr' },
  { section: 'appenzello', prefix: '/cerca-lavoro-appenzello', locale: 'it' },
  { section: 'appenzello', prefix: '/en/find-jobs-appenzell', locale: 'en' },
  { section: 'appenzello', prefix: '/de/jobs-in-appenzell', locale: 'de' },
  { section: 'appenzello', prefix: '/fr/trouver-emploi-appenzell', locale: 'fr' },
  { section: 'basilea', prefix: '/cerca-lavoro-basilea', locale: 'it' },
  { section: 'basilea', prefix: '/en/find-jobs-basel', locale: 'en' },
  { section: 'basilea', prefix: '/de/jobs-in-basel', locale: 'de' },
  { section: 'basilea', prefix: '/fr/trouver-emploi-bale', locale: 'fr' },
  { section: 'berna', prefix: '/cerca-lavoro-berna', locale: 'it' },
  { section: 'berna', prefix: '/en/find-jobs-bern', locale: 'en' },
  { section: 'berna', prefix: '/de/jobs-in-bern', locale: 'de' },
  { section: 'berna', prefix: '/fr/trouver-emploi-berne', locale: 'fr' },
  { section: 'friburgo', prefix: '/cerca-lavoro-friburgo', locale: 'it' },
  { section: 'friburgo', prefix: '/en/find-jobs-fribourg', locale: 'en' },
  { section: 'friburgo', prefix: '/de/jobs-in-freiburg', locale: 'de' },
  { section: 'friburgo', prefix: '/fr/trouver-emploi-fribourg', locale: 'fr' },
  { section: 'ginevra', prefix: '/cerca-lavoro-ginevra', locale: 'it' },
  { section: 'ginevra', prefix: '/en/find-jobs-geneva', locale: 'en' },
  { section: 'ginevra', prefix: '/de/jobs-in-genf', locale: 'de' },
  { section: 'ginevra', prefix: '/fr/trouver-emploi-geneve', locale: 'fr' },
  { section: 'glarona', prefix: '/cerca-lavoro-glarona', locale: 'it' },
  { section: 'glarona', prefix: '/en/find-jobs-glarus', locale: 'en' },
  { section: 'glarona', prefix: '/de/jobs-in-glarus', locale: 'de' },
  { section: 'glarona', prefix: '/fr/trouver-emploi-glaris', locale: 'fr' },
  { section: 'grigioni', prefix: '/cerca-lavoro-grigioni', locale: 'it' },
  { section: 'grigioni', prefix: '/en/find-jobs-graubunden', locale: 'en' },
  { section: 'grigioni', prefix: '/de/jobs-in-graubunden', locale: 'de' },
  { section: 'grigioni', prefix: '/fr/trouver-emploi-grisons', locale: 'fr' },
  { section: 'giura', prefix: '/cerca-lavoro-giura', locale: 'it' },
  { section: 'giura', prefix: '/en/find-jobs-jura', locale: 'en' },
  { section: 'giura', prefix: '/de/jobs-im-jura', locale: 'de' },
  { section: 'giura', prefix: '/fr/trouver-emploi-jura', locale: 'fr' },
  { section: 'lucerna', prefix: '/cerca-lavoro-lucerna', locale: 'it' },
  { section: 'lucerna', prefix: '/en/find-jobs-lucerne', locale: 'en' },
  { section: 'lucerna', prefix: '/de/jobs-in-luzern', locale: 'de' },
  { section: 'lucerna', prefix: '/fr/trouver-emploi-lucerne', locale: 'fr' },
  { section: 'neuchatel', prefix: '/cerca-lavoro-neuchatel', locale: 'it' },
  { section: 'neuchatel', prefix: '/en/find-jobs-neuchatel', locale: 'en' },
  { section: 'neuchatel', prefix: '/de/jobs-in-neuenburg', locale: 'de' },
  { section: 'neuchatel', prefix: '/fr/trouver-emploi-neuchatel', locale: 'fr' },
  { section: 'nidvaldo', prefix: '/cerca-lavoro-nidvaldo', locale: 'it' },
  { section: 'nidvaldo', prefix: '/en/find-jobs-nidwalden', locale: 'en' },
  { section: 'nidvaldo', prefix: '/de/jobs-in-nidwalden', locale: 'de' },
  { section: 'nidvaldo', prefix: '/fr/trouver-emploi-nidwald', locale: 'fr' },
  { section: 'obvaldo', prefix: '/cerca-lavoro-obvaldo', locale: 'it' },
  { section: 'obvaldo', prefix: '/en/find-jobs-obwalden', locale: 'en' },
  { section: 'obvaldo', prefix: '/de/jobs-in-obwalden', locale: 'de' },
  { section: 'obvaldo', prefix: '/fr/trouver-emploi-obwald', locale: 'fr' },
  { section: 'sciaffusa', prefix: '/cerca-lavoro-sciaffusa', locale: 'it' },
  { section: 'sciaffusa', prefix: '/en/find-jobs-schaffhausen', locale: 'en' },
  { section: 'sciaffusa', prefix: '/de/jobs-in-schaffhausen', locale: 'de' },
  { section: 'sciaffusa', prefix: '/fr/trouver-emploi-schaffhouse', locale: 'fr' },
  { section: 'soletta', prefix: '/cerca-lavoro-soletta', locale: 'it' },
  { section: 'soletta', prefix: '/en/find-jobs-solothurn', locale: 'en' },
  { section: 'soletta', prefix: '/de/jobs-in-solothurn', locale: 'de' },
  { section: 'soletta', prefix: '/fr/trouver-emploi-soleure', locale: 'fr' },
  { section: 'svitto', prefix: '/cerca-lavoro-svitto', locale: 'it' },
  { section: 'svitto', prefix: '/en/find-jobs-schwyz', locale: 'en' },
  { section: 'svitto', prefix: '/de/jobs-in-schwyz', locale: 'de' },
  { section: 'svitto', prefix: '/fr/trouver-emploi-schwytz', locale: 'fr' },
  { section: 'turgovia', prefix: '/cerca-lavoro-turgovia', locale: 'it' },
  { section: 'turgovia', prefix: '/en/find-jobs-thurgau', locale: 'en' },
  { section: 'turgovia', prefix: '/de/jobs-im-thurgau', locale: 'de' },
  { section: 'turgovia', prefix: '/fr/trouver-emploi-thurgovie', locale: 'fr' },
  { section: 'uri', prefix: '/cerca-lavoro-uri', locale: 'it' },
  { section: 'uri', prefix: '/en/find-jobs-uri', locale: 'en' },
  { section: 'uri', prefix: '/de/jobs-in-uri', locale: 'de' },
  { section: 'uri', prefix: '/fr/trouver-emploi-uri', locale: 'fr' },
  { section: 'vaud', prefix: '/cerca-lavoro-vaud', locale: 'it' },
  { section: 'vaud', prefix: '/en/find-jobs-vaud', locale: 'en' },
  { section: 'vaud', prefix: '/de/jobs-in-der-waadt', locale: 'de' },
  { section: 'vaud', prefix: '/fr/trouver-emploi-vaud', locale: 'fr' },
  { section: 'vallese', prefix: '/cerca-lavoro-vallese', locale: 'it' },
  { section: 'vallese', prefix: '/en/find-jobs-valais', locale: 'en' },
  { section: 'vallese', prefix: '/de/jobs-im-wallis', locale: 'de' },
  { section: 'vallese', prefix: '/fr/trouver-emploi-valais', locale: 'fr' },
  { section: 'zugo', prefix: '/cerca-lavoro-zugo', locale: 'it' },
  { section: 'zugo', prefix: '/en/find-jobs-zug', locale: 'en' },
  { section: 'zugo', prefix: '/de/jobs-in-zug', locale: 'de' },
  { section: 'zugo', prefix: '/fr/trouver-emploi-zoug', locale: 'fr' },
  { section: 'sangallo', prefix: '/cerca-lavoro-san-gallo', locale: 'it' },
  { section: 'sangallo', prefix: '/en/find-jobs-st-gallen', locale: 'en' },
  { section: 'sangallo', prefix: '/de/jobs-in-st-gallen', locale: 'de' },
  { section: 'sangallo', prefix: '/fr/trouver-emploi-saint-gall', locale: 'fr' },
  { section: 'articolifrontaliere', prefix: '/articoli-frontaliere', locale: 'it' },
  { section: 'articolifrontaliere', prefix: '/en/cross-border-articles', locale: 'en' },
  { section: 'articolifrontaliere', prefix: '/de/grenzgaenger-artikel', locale: 'de' },
  { section: 'articolifrontaliere', prefix: '/fr/articles-frontalier', locale: 'fr' },
  { section: 'articolisvizzera', prefix: '/articoli-svizzera', locale: 'it' },
  { section: 'articolisvizzera', prefix: '/en/swiss-articles', locale: 'en' },
  { section: 'articolisvizzera', prefix: '/de/schweiz-artikel', locale: 'de' },
  { section: 'articolisvizzera', prefix: '/fr/articles-suisse', locale: 'fr' },
];

// Returns the matching SECTION_ROUTES entry ({ section, prefix, locale }) when the
// path is a section root, the .html flat root, or anything under it; null
// otherwise. Anchored so a look-alike section like /cerca-lavoro-ticino-altro
// never matches.
function matchSection(pathname) {
  for (const route of SECTION_ROUTES) {
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
  '/disiscrivi-promemoria-salvati': `${CF_FN_BASE}/savedJobsDigestUnsubscribe`,
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
// Renamed from JOB_CANON_CDN_BASE (issue #4881 Fase 3): the value is the
// generic R2/CDN custom domain, not job-canon-specific — servePushedEdgeFile
// below reads a second, unrelated key family (sitemap/rss/llms.txt) from the
// same base, so a job-canon-scoped name would be misleading. One constant,
// reused, instead of a second copy of the literal (which would itself trip
// check-sibling-patterns.mjs).
const CDN_BASE = 'https://cdn.frontaliereticino.ch';

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
    const mapUrl = new URL(`/job-canon/${sk}.json`, CDN_BASE);
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

// Pushable-origin edge files (issue #4881 Fase 3, fast-publish path).
//
// scripts/create-article.mjs already regenerates sitemap/RSS/llms.txt in the
// SAME commit as a fast-published article — the content is correct the moment
// that commit lands. What is NOT fast is where it's SERVED from: today these
// apex paths are pure Cloudflare passthrough straight to the monolithic
// GitHub Pages deploy (see the file-header comment "/rss-en.xml, /sitemap-*
// -> tiny root files kept in the main repo (passthrough)"), which can lag the
// fast-published commit by hours. scripts/publish-edge-files.mjs PUTs the
// freshly-regenerated file to R2 (via scripts/lib/upload-cdn-file.sh) right
// after the fast-publish commit; this table lets the matching apex path be
// served from that R2 copy instead of waiting for the next full deploy.
//
// Rollout is one path at a time (starting with /sitemap-blog-ch.xml,
// deliberately the lowest-traffic sitemap) — adding a path is a config-only
// addition to this object, no dispatch-logic change.
//
// Exact-path-first, same shape as UNSUB_PROXIES/unsubProxyOrigin above: these
// are apex files, not locale/section paths, so they are checked in fetch()
// BEFORE matchSection/LOCALE_RE or they would fall through unmatched anyway
// (harmlessly, to the same passthrough — see servePushedEdgeFile's fail-open
// note below).
const EDGE_PUSHED_FILES = {
  '/sitemap-blog-ch.xml': { cdnKey: '/edge/sitemap-blog-ch.xml', contentType: 'application/xml; charset=utf-8' },
};
const EDGE_PUSHED_FETCH_TIMEOUT_MS = 2000;
// Short TTL by design, and NOT a substitute for the purge below: the zone's
// it-apex-html-cache Cache Rule (scripts/cf-locale-failover-setup.mjs) matches
// on host + method + empty query string + path-prefix only — it has no
// content-type/extension condition, so it is NOT scoped to HTML and DOES
// match this apex path too, with edge_ttl `override_origin` default 86400
// (24h) that would win over this 5-min value if the zone cache layer is
// consulted for this response. Whether a Worker-routed response is actually
// written to that cache layer on the normal (non-fail-open) path is not
// something this comment asserts either way (see "Workers run before the
// cache" at the top of this file) — worst case is bounded at 24h regardless.
// scripts/publish-edge-files.mjs fires a targeted `cf-purge-cache.mjs
// --files=` purge for the live + CDN URL right after the PUT, which is what
// actually keeps the typical staleness window short — this TTL is only the
// worst-case ceiling if that purge is skipped/fails.
const EDGE_PUSHED_CACHE_TTL = 300; // 5 min

// Returns a 200 Response served from the R2-pushed copy of `pathname`, or
// null when the path is not in EDGE_PUSHED_FILES, the object hasn't been
// published yet (R2 miss), or the subrequest fails/times out. Mirrors
// recoverCantonDriftOrphan's defensive posture exactly: best-effort, fail
// open on ANY error — the caller (fetch() below) then falls through to the
// existing dispatch chain, which lands on the SAME origin passthrough that
// already serves this file today. An entry whose R2 object is absent is
// therefore byte-identical in behavior to before this table existed.
async function servePushedEdgeFile(pathname) {
  const entry = EDGE_PUSHED_FILES[pathname];
  if (!entry) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EDGE_PUSHED_FETCH_TIMEOUT_MS);
  try {
    const cdnUrl = new URL(entry.cdnKey, CDN_BASE);
    const resp = await fetch(cdnUrl.toString(), {
      signal: controller.signal,
      cf: { cacheEverything: true, cacheTtl: EDGE_PUSHED_CACHE_TTL },
    });
    if (!resp.ok) return null; // not yet published (or purged/expired) → origin passthrough
    const body = await resp.arrayBuffer();
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': entry.contentType,
        'Cache-Control': `public, max-age=${EDGE_PUSHED_CACHE_TTL}`,
      },
    });
  } catch {
    return null; // timeout / network error → origin passthrough
  } finally {
    clearTimeout(timer);
  }
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

// Serve a request from a GitHub Pages shard origin (locale shard or a section
// shard). Rewrites only the upstream Host to `origin` (the gray-cloud custom
// domain reachable solely from this Worker); the public URL the user sees never
// changes. Applies the full shard pipeline: tiered edge cache + one retry,
// stale-if-error from the apex-keyed Cache API, origin→apex Location rewrite,
// Cache-Control stamping, apex-keyed fail-open warmup on 200s, and the job-orphan
// 301 recoveries on 404s. `recoveryLocale` (it|en|de|fr) selects which
// within-locale recovery map/board to use — for an IT section subtree it is
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

    // Pushable-origin edge files (issue #4881 Fase 3) — exact apex paths, not
    // locale/section prefixed, so (like the unsub proxy above) must be
    // checked before the locale/section dispatch or they'd fall through
    // unmatched. servePushedEdgeFile fails open (returns null) on any R2
    // miss/timeout/error, so this is a pure addition: nothing changes for a
    // path that never had a fast R2-published copy.
    const pushedEdgeResponse = await servePushedEdgeFile(url.pathname);
    if (pushedEdgeResponse) return pushedEdgeResponse;

    // Section shard — checked BEFORE the locale match so an /en|/de|/fr section
    // path (e.g. /en/find-jobs-ticino/..., /en/find-jobs-zurich/...) resolves to
    // its carved-out section shard, instead of origin-{loc}. Each section's IT
    // prefix reaches the Worker via its own wrangler routes; all other IT paths
    // stay a pure apex passthrough (the !match branch below).
    const sec = matchSection(url.pathname);
    if (sec) {
      return serveShard(request, url, SECTION_ORIGIN[sec.section][sec.locale], sec.locale, ctx);
    }

    const match = url.pathname.match(LOCALE_RE);

    if (!match) {
      // IT + shared (sitemaps, robots, rss, favicon, /...) — passthrough.
      // MOSTLY UNREACHABLE, no longer strictly DEFENSIVE: wrangler.toml scopes
      // the Worker to locale routes + section prefixes + the exact
      // EDGE_PUSHED_FILES paths above (issue #4881 Fase 3), so this branch is
      // only reached today by (a) an EDGE_PUSHED_FILES path whose R2 copy
      // missed/errored just above, falling through here on purpose, or (b) a
      // route scope expansion. Every other IT path bypasses the Worker
      // entirely as a pure CF passthrough. The timeout+retry guard mirrors the
      // shard-origin layer. No cf caching opts: this passthrough must respect
      // the zone's own cache rules.
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
