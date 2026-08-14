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

// Named export for the same reason SECTION_ROUTES below carries one: the
// Workers runtime only ever uses the default export, but scripts/lib/cf-worker-routes.mjs
// needs the real table to name the host a shard path's cache entry is keyed on
// (#5483). A second copy over there would drift the day a locale is added, and
// the symptom would be a purge that reports success against a host that never
// held the entry.
export const SHARD_ORIGIN = {
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
// Named export for the same reason as SHARD_ORIGIN above (#5483).
export const SECTION_ORIGIN = {
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

// ── Keeping the credential out of Cloud Run's request log (#5746) ───────────
//
// Cloud Run writes `httpRequest.requestUrl` — the whole URL, query string
// included — for every invocation of the four functions above, into the
// `_Default` bucket, readable by anybody with `logging.viewer`. Measured over
// the seven days to 2026-08-13: 3.131 requests carrying BOTH an address and a
// credential, 995 distinct real addresses. Identity and session key, appaired,
// in a log.
//
// The SPA's own calls (~89% of that volume) moved into a POST body, which needs
// nothing from here. What is left is a link inside an email, and that link
//
//   - is a GET issued by a mail client, so it has no body to move anything into;
//   - must keep working with NO JavaScript — these four functions render the
//     confirmation page themselves for exactly that reason, so the fragment `#`,
//     which never reaches a server at all, is not available either;
//   - was minted years ago in some cases and cannot be reshaped retroactively;
//   - may arrive as an RFC 8058 one-click POST, whose body is fixed to
//     `List-Unsubscribe=One-Click` and whose identifiers RFC 8058 puts in the URI.
//
// So the move happens HERE, on the hop the recipient's client never sees: the
// sensitive parameters come off the upstream URL and go back on as a request
// header. Method, body, status and response body are untouched — a human still
// gets the same rendered page, a one-click POST still POSTs, and #5711's verb
// gate still sees the verb the client actually used. An old link and a new link
// are byte-identical here, because the transformation is applied to whatever
// arrives rather than to whatever we mint.
//
// The header is a TRANSPORT and grants nothing: every value in it is verified
// upstream exactly as it was on the query string.
export const PRIVATE_PARAMS_HEADER = 'X-Fte-Private-Params';

// Set by an upstream that actually read the header
// (functions/src/lib/privateRequestParams.js). Its ABSENCE is what licenses the
// legacy replay below.
export const PRIVATE_PARAMS_ACK_HEADER = 'x-fte-private-params-read';

/**
 * The parameters that must not appear in a request-log row.
 *
 * `email`/`ne` are the identity, `token`/`t`/`ac` are the credential, and it is
 * the PAIR that makes a log line usable — but each half is moved on its own,
 * because "only an address" is still personal data and "only a code" is still a
 * key. Everything else stays on the URL on purpose: `action`, `alertId`, `uid`,
 * `c`, `format`, `utm_*` are what make the request log worth keeping, and none
 * of them identifies a person or opens a session.
 */
export const PRIVATE_UNSUB_PARAMS = Object.freeze(['email', 'ne', 'token', 't', 'ac']);

/**
 * Statuses that may mean "the upstream did not understand the header".
 *
 * A pre-#5746 function handed a stripped URL answers 400 (missing address —
 * newsletterManageSubscription, jobAlertUnsubscribe) or 403 (credential failed
 * to verify because it never arrived — savedJobsDigestUnsubscribe,
 * outreachUnsubscribe). Both refuse BEFORE any write, so replaying them is
 * side-effect free. 5xx is deliberately not here: a 500 may land after a write,
 * and repeating it would be the one way this could unsubscribe somebody twice.
 */
const LEGACY_REPLAY_STATUSES = new Set([400, 403]);

/**
 * Split a proxied unsubscribe query string into the half that may be logged and
 * the half that may not.
 *
 * Order and repetition are preserved within each half, so the upstream sees the
 * same multi-value parameters it would have seen on the URL. Both halves are
 * `URLSearchParams`, and the upstream parses the header with `URLSearchParams`
 * too — the two sides are inverse by construction rather than by an escaping
 * convention somebody has to keep in step.
 *
 * @param {URLSearchParams} searchParams
 * @returns {{publicParams: URLSearchParams, privateParams: URLSearchParams}}
 */
export function splitPrivateUnsubParams(searchParams) {
  const publicParams = new URLSearchParams();
  const privateParams = new URLSearchParams();
  for (const [key, value] of searchParams) {
    if (PRIVATE_UNSUB_PARAMS.includes(key)) privateParams.append(key, value);
    else publicParams.append(key, value);
  }
  return { publicParams, privateParams };
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
// Exported (like SECTION_ROUTES above) so scripts/publish-edge-files.mjs can
// build the same CDN URL it PUTs the file to, instead of a second hardcoded
// copy of this domain — single source of truth for both the read (this
// Worker) and write (that script) sides of the same key family.
export const CDN_BASE = 'https://cdn.frontaliereticino.ch';

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
// scripts/create-article.mjs already regenerates sitemap/RSS in the SAME
// commit as a fast-published article — the content is correct the moment
// that commit lands. llms.txt is different: it is NOT touched by
// create-article.mjs at all — it needs its own render step
// (scripts/lib/llms-txt-generator.mjs), which publish-edge-files.mjs runs
// into a scratch dir before PUTting the "generated"-source entries below.
// Either way, what is NOT fast is where the file is SERVED from: today these
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
//
// Exported so scripts/publish-edge-files.mjs (the write side) iterates this
// SAME table instead of a second hardcoded path/key list — adding a path
// here is then the ONLY code-side change needed for both read and write
// (plus the matching wrangler.toml route), never two edits that can drift.
//
// llms.txt family, rollout step 2 (issue #4881 residual): llms.txt/
// llms-full.txt/.well-known/llms.txt are rendered by
// scripts/lib/llms-txt-generator.mjs (generateLlmsTxtFamily) rather than
// copied as-is, so publish-edge-files.mjs runs that generator into a scratch
// dir first — see its own header comment. "Needs a render step" is no longer
// a reason to leave a member out; these three are apex, same passthrough
// mechanism as sitemap-blog-ch.xml above (measured via a real run of
// generate-llms-txt.mjs: llms.txt/.well-known/llms.txt ~32 KB each,
// llms-full.txt ~1.07 MB — still a single per-publish PUT, same as any other
// registered file here).
//
// Deliberately NOT registered here: /en/llms.txt, /de/llms.txt, /fr/llms.txt
// (the other 3 members generateLlmsTxtFamily writes). The reason is the
// mechanism, not the size (the measured ~485-505 KB per locale file is
// actually SMALLER than llms-full.txt above, ruling out size as the
// deciding factor either way): those paths are not apex passthrough today —
// LOCALE_RE routes them to serveShard(SHARD_ORIGIN.{en,de,fr}), a wholly
// different origin (each locale's own GitHub Pages shard repo, refreshed
// only by that shard's own full deploy, untouched by fast-publish).
// Special-casing just their llms.txt to the R2 edge would serve ONE file in
// that shard from a different mechanism/cadence than every other file in it,
// for a freshness gain of one incremental URL among thousands already
// listed. The next full deploy refreshes them on its normal cadence, same
// as before this table existed.
// Every entry below carries a `producer` field naming WHO is responsible for
// keeping its R2 copy fresh — added by issue #5458 after deploy.yml's bare
// (no `--only`) invocation of publish-edge-files.mjs was found re-publishing
// the WHOLE table from its own checkout, which can be 2h30m+ stale by the
// time that step runs. An unscoped re-PUT overwrote entries that OTHER,
// faster automatic publishers keep current, undoing their work every deploy.
// `producer` is what lets deploy.yml (and the tests below) tell "mine" from
// "not mine" without re-deriving it from prose each time:
//
//   'build'      — this repo's OWN full-site build (deploy.yml). The bare
//                  invocation is now `--producer=build`, which resolves
//                  against THIS table — never a second hardcoded path list.
//   'sync'       — this repo's sync-articles-sitemaps.yml, which both pulls
//                  the file into public/ AND pushes it to R2 itself with an
//                  explicit `--only=` naming it (see that workflow).
//   'corpus'     — nanakokyobashi-rgb/frontaliere-articles' publish-api.yml
//                  PUTs it straight to the SAME `edge/<name>` R2 key from its
//                  own job, cross-repo, on every push to its main that
//                  touches content/. This repo's checkout only ever carries a
//                  copy pulled in afterwards — it must never re-publish it.
//   'hub-render' — rerender-article-hubs.yml (push/workflow_run — automatic,
//                  in-repo), which selects its `--only` pathname at RUNTIME
//                  from that run's own render summary (`--only="/$REL"`), so
//                  it can never appear as a literal string in the workflow
//                  source. publish-article-fast.mjs also writes these from a
//                  fast-publish render, but only on workflow_dispatch (manual
//                  — not what keeps this path off deploy.yml's list).
//
// tests/locale-router-edge-pushed-files.test.ts asserts deploy.yml's
// invocation resolves to producer: 'build' entries ONLY, and that every
// entry's declared producer matches a real automatic publisher (in-repo
// where that's checkable; documented here with its source cited where it
// isn't, i.e. 'corpus').
export const EDGE_PUSHED_FILES = {
  // Registered for CORRECTNESS, not just freshness (issue #4974). Measured on
  // the live site: the committed public/sitemap-blog.xml carries 3046 <url> and
  // 15230 <xhtml:link> hreflang alternates, while the copy served from the apex
  // passthrough origin had the same url count and ZERO alternates — the
  // <image:image>, <lastmod>, <changefreq> and <priority> blocks all survived,
  // only the alternates were gone. Verified against the exact commit the last
  // successful deploy built (6c1ed313): 15225 alternates in the source, none in
  // what was served. Its sibling /sitemap-blog-ch.xml, already registered here,
  // is byte-identical live to its committed copy — same generator, same shape,
  // different serving path. Whatever drops them lives downstream of the file
  // this repo commits, and the edge origin bypasses it entirely.
  //
  // 15225 hreflang alternates missing from the index is not a freshness
  // nuisance: it is every article's locale variants going unlinked.
  //
  // It is not one file, either — measured live against that same commit, every
  // sitemap on the apex passthrough loses them, and the one already served from
  // here does not:
  //
  //   sitemap-blog.xml       15230 committed → 0 live
  //   sitemap-glossario.xml    210 committed → 0 live
  //   sitemap-news.xml          50 committed → 0 live
  //   sitemap-blog-ch.xml     2825 committed → 2825 live   (already edge-served)
  //
  // So all three move, not just the one that started the investigation.
  // sitemap-news.xml is the Google News surface, and sitemap-glossario.xml is a
  // 42-url hub — small files, but the alternates are the whole point of having
  // four locales.
  //
  // NOT included: sitemap-pages.xml, which loses SOME (1480 → 190) rather than
  // all of them. A partial loss is a different signature and plausibly the
  // reciprocity sanitizer doing its job, so lumping it in here would be
  // guessing. It is called out in the PR body as still open.
  '/sitemap-blog.xml': { cdnKey: '/edge/sitemap-blog.xml', contentType: 'application/xml; charset=utf-8', producer: 'corpus' },
  '/sitemap-blog-ch.xml': { cdnKey: '/edge/sitemap-blog-ch.xml', contentType: 'application/xml; charset=utf-8', producer: 'corpus' },
  // Same reason as its two siblings above, and it never had a passthrough
  // copy to fall back to: /sitemap-articles-archive.xml is published by the
  // corpus only. Its page-1 entries carry the four locale alternates plus
  // x-default — exactly what the apex origin drops.
  '/sitemap-articles-archive.xml': { cdnKey: '/edge/sitemap-articles-archive.xml', contentType: 'application/xml; charset=utf-8', producer: 'corpus' },
  // Unlike its three siblings above, this one IS a build-owned entry:
  // sitemap-glossario.xml comes from this repo's own static glossary pages
  // (build-plugins/staticPagesPlugin.ts + scripts/lib/sitemap-files.mjs), not
  // from the article corpus — deploy.yml's full build is its only producer.
  '/sitemap-glossario.xml': { cdnKey: '/edge/sitemap-glossario.xml', contentType: 'application/xml; charset=utf-8', producer: 'build' },
  '/sitemap-news.xml': { cdnKey: '/edge/sitemap-news.xml', contentType: 'application/xml; charset=utf-8', producer: 'sync' },
  // Article topic hubs (#5001). Registered for FRESHNESS in the strict sense:
  // these two files are the only sitemaps on this list whose PAGES are not
  // produced by the full build at all. Both article sections run with
  // BUILD_EMIT_SKIP=true (deploy.yml) — "served by fast-publish only" — so
  // `scripts/publish-article-fast.mjs` writes the hub pages, pushes them to
  // the section shards, and writes these two files from that same render.
  //
  // The committed public/ copies keep the apex origin (and therefore the
  // sitemap index, which sitemapAliasPlugin builds by discovering
  // dist/sitemap-*.xml) honest between deploys; the R2 copy pushed on every
  // fast publish is what keeps the URL list in step with the shards, which is
  // the half that was missing. Measured 2026-08-07 before this: the apex
  // sitemap-topics.xml announced 36 page-N URLs that no shard had, and missed
  // 32 that every shard did — a full-build snapshot describing a fast-publish
  // filesystem.
  '/sitemap-topics-frontaliere.xml': { cdnKey: '/edge/sitemap-topics-frontaliere.xml', contentType: 'application/xml; charset=utf-8', producer: 'hub-render' },
  '/sitemap-topics-svizzera.xml': { cdnKey: '/edge/sitemap-topics-svizzera.xml', contentType: 'application/xml; charset=utf-8', producer: 'hub-render' },
  // The ten RSS feeds (#5420 follow-up). Same defect as the sitemaps above, a
  // different surface — and the one nobody re-checks, because a feed is a
  // SUBSCRIPTION: whoever reads it does not come back to see whether it moved.
  //
  // Measured 2026-08-09 12:05 UTC, before this: /rss.xml on the apex carried
  // lastBuildDate 08:32:36 against the corpus's 11:30:02 — 2h57m26s stale, and
  // on GUIDs (the lens the dates do not give) 5 of 50 items simply absent, the
  // same 5 in rss.xml / rss-it / rss-en / rss-de / rss-fr. Those five articles
  // answer 200 and were ALREADY announced by /sitemap-blog.xml on the same
  // apex in the same minute: the incoherence is internal to one host.
  //
  // The cause is not the sync — public/rss.xml on main is byte-identical to
  // the corpus copy (424.390 byte), and the pull runs green every ~40 min. It
  // is that no writer ever PUT these to R2: /edge/sitemap-blog.xml existed and
  // was 40 seconds old, /edge/rss.xml answered 404. Never written by anyone.
  //
  // The svizzera feeds measured a delta of ZERO, which is not reassurance: the
  // swiss section had published nothing for 14h (see corpus#96), so there was
  // nothing in flight to be late. Same mechanism, empty pipe.
  //
  // contentType stays application/xml (what Pages serves today) rather than the
  // canonical application/rss+xml: the only variable this change may move is
  // freshness.
  '/rss.xml': { cdnKey: '/edge/rss.xml', contentType: 'application/xml; charset=utf-8', producer: 'sync' },
  '/rss-it.xml': { cdnKey: '/edge/rss-it.xml', contentType: 'application/xml; charset=utf-8', producer: 'sync' },
  '/rss-en.xml': { cdnKey: '/edge/rss-en.xml', contentType: 'application/xml; charset=utf-8', producer: 'sync' },
  '/rss-de.xml': { cdnKey: '/edge/rss-de.xml', contentType: 'application/xml; charset=utf-8', producer: 'sync' },
  '/rss-fr.xml': { cdnKey: '/edge/rss-fr.xml', contentType: 'application/xml; charset=utf-8', producer: 'sync' },
  '/rss-svizzera.xml': { cdnKey: '/edge/rss-svizzera.xml', contentType: 'application/xml; charset=utf-8', producer: 'sync' },
  '/rss-svizzera-it.xml': { cdnKey: '/edge/rss-svizzera-it.xml', contentType: 'application/xml; charset=utf-8', producer: 'sync' },
  '/rss-svizzera-en.xml': { cdnKey: '/edge/rss-svizzera-en.xml', contentType: 'application/xml; charset=utf-8', producer: 'sync' },
  '/rss-svizzera-de.xml': { cdnKey: '/edge/rss-svizzera-de.xml', contentType: 'application/xml; charset=utf-8', producer: 'sync' },
  '/rss-svizzera-fr.xml': { cdnKey: '/edge/rss-svizzera-fr.xml', contentType: 'application/xml; charset=utf-8', producer: 'sync' },
  // The llms.txt family is 'generated' (rendered fresh at publish time, see
  // the header comment above) AND producer: 'build' — deploy.yml is the only
  // automatic caller that has a fully-built dist/ for generate-llms-txt.mjs
  // to render against (fast-publish-article.yml also generates it, but only
  // on workflow_dispatch — manual, not an automatic producer).
  '/llms.txt': { cdnKey: '/edge/llms.txt', contentType: 'text/plain; charset=utf-8', source: 'generated', producer: 'build' },
  '/llms-full.txt': { cdnKey: '/edge/llms-full.txt', contentType: 'text/plain; charset=utf-8', source: 'generated', producer: 'build' },
  '/.well-known/llms.txt': {
    cdnKey: '/edge/.well-known/llms.txt',
    contentType: 'text/plain; charset=utf-8',
    source: 'generated',
    producer: 'build',
  },
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
//
// Exported so publish-edge-files.mjs sets the SAME value as the R2 object's
// own Cache-Control on PUT — one number, not a second literal `300` that
// could silently drift from this one.
export const EDGE_PUSHED_CACHE_TTL = 300; // 5 min

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

// ────────────────────────────────────────────────────────────────────────────
// RETIRED PATHS, SERVED AT THE EDGE (issue #5369 §4)
// ────────────────────────────────────────────────────────────────────────────
//
// THE DEFECT THIS CLOSES
// ──────────────────────
// The two article sections run with `<SECTION>_BUILD_EMIT_SKIP=true`; matchSection
// below sends their eight prefixes to `SECTION_ORIGIN[section][locale]` with no
// apex fallback, and deploy.yml excludes them from the full-replace shard push.
// The shard is therefore APPEND-ONLY for those prefixes: nothing this repo builds
// can remove or overwrite a page already on it.
//
// So retiring an article did not deindex it. `legacyRedirectsPlugin`'s table is
// the site's declaration of "this URL is gone, go there instead", but for a path
// under those eight prefixes the bridge it writes into dist/ is deleted by
// scripts/lib/rehydrate-trunk-guard.sh and never reaches the serving path.
// build-plugins/shared/unshippableSections.ts made the build STOP emitting those
// inert bridges — correct, and it left the URLs exactly as they were.
//
// MEASURED ON THE LIVE APEX, 2026-08-14, bare URLs, no `-L` (a `?cb=1` probe
// measures a different origin on some apex paths — see wrangler.toml):
//
//   38/38 legacyRedirectsPlugin entries under the eight prefixes answer 200.
//     22/38 → the "Pagina spostata" bridge, noindex,follow + canonical → target.
//             STALE SHARD FILES from the last full-replace push before the flag
//             went on: they work by an accident of history, not because anything
//             ships them. The next full-replace push removes them.
//     16/38 → the ORIGINAL RETIRED ARTICLE, `index, follow, max-snippet:-1, …`,
//             SELF-canonical. Google is being told to index four withdrawn
//             articles in four locales. One of the four
//             (prezzi-proprieta-svizzera-aumentano) is declared unpublishable at
//             the source: it cites five Swiss laws that do not exist.
//      0/38 → 404.
//    3/3 entries of data/article-redirects.json (merged into the SAME map at
//             closeBundle, issue #5352) answer 200 `index, follow` SELF-canonical
//             at BOTH ends: /en|/de|/fr .../slug-gaggiolo-*/ and the clean
//             .../gaggiolo-*/ they redirect to are a live duplicate pair.
//   20/21 data/legacy-aliases.json orphanPaths under the same prefixes answer
//             200 with the shard's "Pagina non disponibile" soft-landing and
//             NO robots meta and NO canonical — a soft-404, indexable. The 21st,
//             /articoli-frontaliere/kebab-case-3-5-words-max-40-chars/, is not an
//             orphan at all any more: the corpus publishes an article at that
//             slug, so the alias row is stale and the URL is left alone (the
//             prompt-leak rename cluster, issue #5369 §6, not this one).
//   Control: /articoli-frontaliere/questo-non-esiste-xyz/ → 404 + noindex, so the
//             200s above are real, not the CDN's courtesy HTML for unknown paths.
//
// WHY HERE AND NOT A FAST-PUBLISH ON THE SHARD
// ────────────────────────────────────────────
// A fast-publish repairs the sixteen URLs that exist today and nothing else: it
// is a manual step per retirement, on a repo this one cannot force-replace, and
// the append-only shard keeps the old bytes underneath. The Worker is the only
// layer that sits in FRONT of the shard for every one of the eight prefixes, so
// a path listed here is answered before `serveShard` ever runs — whatever the
// shard still holds. And it is no longer a manual deploy: .github/workflows/
// deploy-worker.yml deploys this file on every push to main that touches
// infra/cloudflare-worker/**, so an entry added here goes live with the merge.
//
// THE FORM IS CHOSEN PER URL, NOT ONE RULE FOR ALL
// ───────────────────────────────────────────────
//   value = '<path>'  →  301 to a substitute that EXISTS and is equivalent.
//                        Strongest signal, transfers the ranking, one hop. Used
//                        for every retirement whose legacyRedirectsPlugin target
//                        is a real document. All 30 distinct targets below were
//                        measured 200 on 2026-08-14 before being written here —
//                        a 301 into a 404 would be worse than the defect.
//   value = null      →  410 Gone: withdrawn ON PURPOSE with NO substitute.
//                        Used where the plugin's only "target" is the section
//                        ROOT (a redirect to a hub is a soft-404 to Google and
//                        keeps the URL alive) and for the alias orphans, which
//                        never had a document at all. The body carries
//                        `noindex` as well, so status and meta say the same
//                        thing — the exact incoherence measured above, where the
//                        soft-404s carried neither.
//
// A live article is never listed. `tests/edge-retired-paths.test.ts` re-derives
// this whole table from legacyRedirectsPlugin's own literal, from
// data/legacy-aliases.json and from the corpus slug registries, and fails on any
// drift in EITHER direction — a retirement declared in the build but missing
// here, or an entry here for a slug the corpus still publishes. That test is the
// mechanism: the next retired article cannot reach main still indexable.
export const EDGE_RETIRED_PATHS = {
  // ── 301 — slug consolidations already declared by legacyRedirectsPlugin (22 URLs).
  '/articoli-frontaliere/naspi-disoccupazione-frontalieri/': '/articoli-frontaliere/naspi-ex-frontalieri-2026/',
  '/articoli-frontaliere/elezioni-comunali-ticino-2026/': '/articoli-frontaliere/elezioni-comunali-ticino/',
  '/en/cross-border-articles/ticino-elections-2026/': '/en/cross-border-articles/municipal-elections-ticino/',
  '/de/grenzgaenger-artikel/gemeindewahlen-tessin-2026/': '/de/grenzgaenger-artikel/gemeindewahlen-tessin/',
  '/articoli-frontaliere/a9-chiusure-notturne-chiasso-como/': '/articoli-frontaliere/chiasso-como-autostrada-a9-chiusure-notturne-cantieri/',
  '/articoli-frontaliere/tassa-transito-svizzera-2023/': '/articoli-frontaliere/tassa-transito-svizzera-2026/',
  '/en/cross-border-articles/transit-fee-switzerland-2023/': '/en/cross-border-articles/transit-fee-switzerland-2026/',
  '/de/grenzgaenger-artikel/transitgebuehr-schweiz-2023/': '/de/grenzgaenger-artikel/transitgebuehr-schweiz-2026/',
  '/fr/articles-frontalier/frais-de-transit-suisse-2023/': '/fr/articles-frontalier/frais-de-transit-suisse-2026/',
  '/en/cross-border-articles/speed-controls-ticino-2026/': '/en/cross-border-articles/ticino-speed-controls-2026/',
  '/articoli-frontaliere/frontalieri-ticino-calo-dati-2025/': '/articoli-frontaliere/frontalieri-ticino-dati-calo-fine-2025/',
  '/en/cross-border-articles/cross-border-workers-ticino-decline-2025-data/': '/en/cross-border-articles/cross-border-workers-ticino-data-decline-end-2025/',
  '/de/grenzgaenger-artikel/grenzgaenger-tessin-rueckgang-daten-2025/': '/de/grenzgaenger-artikel/grenzgaenger-tessin-daten-rueckgang-ende-2025/',
  '/articoli-frontaliere/frontalieri-ticino-dati-calo-q4-2025/': '/articoli-frontaliere/frontalieri-ticino-dati-calo-fine-2025/',
  '/en/cross-border-articles/cross-border-workers-ticino-data-decline-q4-2025/': '/en/cross-border-articles/cross-border-workers-ticino-data-decline-end-2025/',
  '/de/grenzgaenger-artikel/grenzgaenger-tessin-daten-rueckgang-q4-2025/': '/de/grenzgaenger-artikel/grenzgaenger-tessin-daten-rueckgang-ende-2025/',
  '/articoli-frontaliere/frontalieri-ticino-calo-dati-q4-2025/': '/articoli-frontaliere/frontalieri-ticino-dati-calo-fine-2025/',
  '/en/cross-border-articles/cross-border-workers-ticino-decline-q4-2025-data/': '/en/cross-border-articles/cross-border-workers-ticino-data-decline-end-2025/',
  '/de/grenzgaenger-artikel/grenzgaenger-tessin-rueckgang-q4-2025-daten/': '/de/grenzgaenger-artikel/grenzgaenger-tessin-daten-rueckgang-ende-2025/',
  '/fr/articles-frontalier/frontaliers-tessin-baisse-donnees-2025/': '/fr/articles-frontalier/frontaliers-tessin-donnees-baisse-fin-2025/',
  '/fr/articles-frontalier/frontaliers-tessin-donnees-baisse-q4-2025/': '/fr/articles-frontalier/frontaliers-tessin-donnees-baisse-fin-2025/',
  '/fr/articles-frontalier/frontaliers-tessin-baisse-donnees-q4-2025/': '/fr/articles-frontalier/frontaliers-tessin-donnees-baisse-fin-2025/',

  // ── 301 — retired articles WITH an equivalent substitute (12 URLs).
  '/articoli-frontaliere/caldo-torrido-lavoro-ticino/': '/articoli-frontaliere/caldo-lavoro-frontalieri-ticino/',
  '/en/cross-border-articles/hot-weather-work-ticino/': '/en/cross-border-articles/heat-work-cross-border-ticino/',
  '/de/grenzgaenger-artikel/heisses-wetter-arbeit-tessin/': '/de/grenzgaenger-artikel/hitze-arbeitsgrenze-tessin/',
  '/fr/articles-frontalier/chaleur-torrida-travail-tessin/': '/fr/articles-frontalier/chaleur-travail-frontalier-tessin/',
  '/articoli-svizzera/lavoro-forzato-catene-svizzere/': '/articoli-svizzera/lavoro-forzato-svizzera/',
  '/en/swiss-articles/forced-labour-swiss-supply-chains/': '/en/swiss-articles/forced-labor-swiss-supply-chains/',
  '/de/schweiz-artikel/zwangsarbeit-schweizer-lieferketten/': '/de/schweiz-artikel/zwangsarbeit-in-schweizer-lieferketten/',
  '/fr/articles-suisse/travail-force-chaines-approvisionnement-suisse/': '/fr/articles-suisse/travail-force-dans-les-chaines-dapprovisionnement-suisses/',
  '/articoli-frontaliere/vivere-maslianico-lavorare-ticino-frontaliere/': '/vivere-in-ticino/comuni-di-frontiera/maslianico/',
  '/en/cross-border-articles/live-maslianico-work-ticino-cross-border/': '/en/living-in-ticino/border-municipalities/maslianico/',
  '/de/grenzgaenger-artikel/in-maslianico-wohnen-arbeiten-tessin-grenzganger/': '/de/leben-im-tessin/grenzgemeinden/maslianico/',
  '/fr/articles-frontalier/vivre-maslianico-travailler-tessin-frontalier/': '/fr/vivre-au-tessin/communes-frontiere/maslianico/',

  // ── 301 — prompt-leak slug renames declared in data/article-redirects.json
  // (3 URLs). Not retirements: the article is fine, the URL carried the prompt's
  // own `slug-` placeholder. Both ends are live 200 `index, follow` self-canonical
  // today, i.e. a duplicate pair, because push-article-shard-incremental.sh only
  // ever ADDS. The 301 is the half that was missing. It does NOT touch the four
  // `kebab-case-*` slugs tests/scripts/create-article-prompt-leak-slug.test.ts
  // deliberately leaves live — those are excluded by the live-slug rule below.
  '/en/cross-border-articles/slug-gaggiolo-traffic/': '/en/cross-border-articles/gaggiolo-traffic/',
  '/de/grenzgaenger-artikel/slug-gaggiolo-verkehr/': '/de/grenzgaenger-artikel/gaggiolo-verkehr/',
  '/fr/articles-frontalier/slug-gaggiolo-traffic/': '/fr/articles-frontalier/gaggiolo-traffic/',

  // ── 410 — retired article with NO substitute (4 URLs).
  '/articoli-frontaliere/prezzi-proprieta-svizzera-aumentano/': null,
  '/en/cross-border-articles/swiss-property-prices-rise/': null,
  '/de/grenzgaenger-artikel/schweizer-immobilienpreise-steigen/': null,
  '/fr/articles-frontalier/prix-immobilier-suisse-augmentent/': null,

  // ── 410 — alias orphans (20 URLs).
  '/de/grenzgaenger-artikel/banken-gewerkschaften-plattform-vereinbarung/': null,
  '/articoli-frontaliere/addiofrontalierelongo/': null,
  '/articoli-frontaliere/tassa-salute-frontalieri/': null,
  '/de/grenzgaenger-artikel/rega-helikopter-locarno/': null,
  '/de/grenzgaenger-artikel/tessin-justiz-referendum-2026/': null,
  '/de/grenzgaenger-artikel/bahnhofsicherheit-tessin-2026/': null,
  '/en/cross-border-articles/malpensa-arrest-cross-border-worker-murder-2026/': null,
  '/en/cross-border-articles/bossi-wanted-good-for-ticino/': null,
  '/en/cross-border-articles/swiss-italy-car-fuel-prices/': null,
  '/fr/articles-frontalier/referendum-justice-tessin-2026/': null,
  '/en/cross-border-articles/swiss-neutrality-initiative/': null,
  '/de/grenzgaenger-artikel/immobilienmarkt-ticino/': null,
  '/en/cross-border-articles/naspi-unemployment-frontaliers/': null,
  '/articoli-frontaliere/governo-tavolo-frontalieri-2026/': null,
  '/en/cross-border-articles/rega-helicopter-locarno/': null,
  '/en/cross-border-articles/switzerland-public-service-tv-fee/': null,
  '/articoli-frontaliere/frontalieri-redditi-2026/': null,
  '/articoli-frontaliere/calo-frontalieri-ticino-economia/': null,
  '/articoli-frontaliere/tassa-salute-frontalieri-ufis-risposte/': null,
  '/articoli-frontaliere/accesso-libero-alle-rive/': null,
};

// Cache-Control for a retirement 301. Longer than NOT_FOUND_CACHE_CONTROL on
// purpose: unlike a 404, which can turn into a 200 the moment a page is
// published, a retirement is a decision — re-checking it every 5 minutes buys
// nothing and the eyeball-side cache is what keeps a crawler's repeat hits off
// the Worker. Still bounded (not immutable) so unwinding a retirement takes
// hours, not a cache purge.
const RETIRED_MOVED_CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400';

// Locale copy for the 410 body. Deliberately tiny and self-contained: no CSS
// file, no bundle, no SPA boot. A Gone page has one job — say so to the crawler
// and give the human one live link — and any asset reference here would be a
// second request into the very shard this response exists to bypass.
const GONE_COPY = {
  it: {
    title: 'Pagina rimossa',
    lede: 'Questo articolo è stato ritirato e non verrà ripubblicato.',
    cta: 'Vai a tutti gli articoli',
  },
  en: {
    title: 'Page removed',
    lede: 'This article has been withdrawn and will not be republished.',
    cta: 'Browse all articles',
  },
  de: {
    title: 'Seite entfernt',
    lede: 'Dieser Artikel wurde zurückgezogen und wird nicht erneut veröffentlicht.',
    cta: 'Alle Artikel ansehen',
  },
  fr: {
    title: 'Page supprimée',
    lede: 'Cet article a été retiré et ne sera pas republié.',
    cta: 'Voir tous les articles',
  },
};

// Table lookup, tolerant of the two forms a crawler actually sends for the same
// resource. The keys are the canonical directory form (trailing slash) because
// that is the form legacyRedirectsPlugin and data/legacy-aliases.json declare;
// Googlebot re-requests both the slashless and the /index.html form from memory,
// and a miss on either would serve the retired article again — the whole defect.
// hasOwnProperty, not `in`: a path like /articoli-frontaliere/constructor/ must
// not inherit a match from Object.prototype.
function lookupRetired(pathname) {
  const own = (key) => Object.prototype.hasOwnProperty.call(EDGE_RETIRED_PATHS, key);
  if (own(pathname)) return EDGE_RETIRED_PATHS[pathname];
  if (!pathname.endsWith('/') && own(`${pathname}/`)) return EDGE_RETIRED_PATHS[`${pathname}/`];
  if (pathname.endsWith('/index.html')) {
    const dir = pathname.slice(0, -'index.html'.length);
    if (own(dir)) return EDGE_RETIRED_PATHS[dir];
  }
  return undefined;
}

/** Locale of a retired path — its section route first, then the /en|/de|/fr prefix. */
function retiredLocale(pathname) {
  const sec = matchSection(pathname);
  if (sec) return sec.locale;
  const m = pathname.match(LOCALE_RE);
  return m ? m[1] : 'it';
}

/** The one live link a 410 offers: the retired path's own section root. */
function retiredHubPath(pathname, locale) {
  const sec = matchSection(pathname);
  if (sec) return `${sec.prefix}/`;
  return locale === 'it' ? '/' : `/${locale}/`;
}

/**
 * The 410 body. `noindex` is the point of it: the measured defect was a soft-404
 * that carried NEITHER the status NOR the meta, so this response states the same
 * thing twice (status 410, meta robots noindex, X-Robots-Tag noindex) and a
 * crawler that honours any one of the three deindexes the URL. No canonical —
 * pointing a gone page at a hub is the soft-404 shape all over again.
 */
function buildGonePage(pathname) {
  const locale = retiredLocale(pathname);
  const copy = GONE_COPY[locale] || GONE_COPY.it;
  const hub = retiredHubPath(pathname, locale);
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${copy.title} — Frontaliere Ticino</title>
</head>
<body>
<main>
<h1>${copy.title}</h1>
<p>${copy.lede}</p>
<p><a href="${hub}">${copy.cta}</a></p>
</main>
</body>
</html>
`;
}

/**
 * Returns the edge response for a retired path — 301 to its substitute, or 410
 * Gone — and null for every other path, which is every path the site actually
 * serves.
 *
 * Exported for tests/edge-retired-paths.test.ts, which exercises THIS function
 * (status, Location, robots meta) rather than grepping the source: the defect it
 * guards was invisible to source-level checks, because the build genuinely
 * contained a correct redirect table the serving path never read.
 */
export function retiredEdgeResponse(url) {
  const target = lookupRetired(url.pathname);
  if (target === undefined) return null;
  if (target === null) {
    return new Response(buildGonePage(url.pathname), {
      status: 410,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': NOT_FOUND_CACHE_CONTROL,
        'X-Robots-Tag': 'noindex',
      },
    });
  }
  return new Response(null, {
    status: 301,
    headers: {
      Location: target + url.search + url.hash,
      'Cache-Control': RETIRED_MOVED_CACHE_CONTROL,
    },
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
      // The address and the credential leave the URL here and travel as a header
      // (#5746) — see PRIVATE_UNSUB_PARAMS above for why this hop and not the
      // link itself, and why not the body or the fragment.
      const { publicParams, privateParams } = splitPrivateUnsubParams(url.searchParams);
      const privateQuery = privateParams.toString();
      const upstream = new URL(unsubOrigin);
      upstream.search = publicParams.toString(); // alertId/uid/c/action/format only
      // Taken BEFORE the first fetch consumes the body, and only when there is
      // something to replay: a one-click POST's body can be read once, and the
      // legacy replay below needs its own copy.
      const legacySource = privateQuery ? request.clone() : null;
      try {
        // new Request(url, request) copies method/headers/body; the upstream host
        // comes from `url` (the Cloud Function ignores the forwarded Host).
        const forwarded = new Request(upstream.toString(), request);
        // Set from the URL we just stripped, or removed outright: the Worker is
        // the ONLY source of this header. A client-supplied one would grant
        // nothing (the upstream verifies whatever it is handed, exactly as it
        // does a query string) but it would make the header's provenance a
        // question, and there is no reason to have one.
        if (privateQuery) forwarded.headers.set(PRIVATE_PARAMS_HEADER, privateQuery);
        else forwarded.headers.delete(PRIVATE_PARAMS_HEADER);
        const response = await fetch(forwarded);
        // Legacy replay, for the minutes where deploy-worker.yml has landed and
        // deploy-cloud-functions.yml has not: an upstream that read the header
        // says so, and one that did not gets the request it has always
        // understood rather than telling somebody their unsubscribe link is
        // invalid. Both halves live ⇒ the acknowledgement is always there ⇒ this
        // branch is unreachable, so a genuinely bad credential is refused
        // without a second, logged, full-URL round trip.
        if (
          !legacySource
          || !LEGACY_REPLAY_STATUSES.has(response.status)
          || response.headers.get(PRIVATE_PARAMS_ACK_HEADER)
        ) {
          return response;
        }
        const legacyUpstream = new URL(unsubOrigin);
        legacyUpstream.search = url.search; // carry alertId/email/token/action or c/t
        return await fetch(new Request(legacyUpstream.toString(), legacySource));
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

    // Retired paths (issue #5369 §4) — 301 to a substitute, or 410 Gone. Must
    // run BEFORE matchSection: every one of these lives under a section prefix,
    // so matchSection would hand it to the append-only shard, which still holds
    // the withdrawn article and serves it 200 `index, follow`. Synchronous table
    // lookup, no subrequest — nothing about a retirement needs the origin's
    // opinion, and asking for it is exactly how the defect survived six days.
    // Placed AFTER servePushedEdgeFile because the two sets are disjoint by
    // construction (apex files vs. section paths) and that keeps the existing
    // fail-open ordering untouched.
    const retiredResponse = retiredEdgeResponse(url);
    if (retiredResponse) return retiredResponse;

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
