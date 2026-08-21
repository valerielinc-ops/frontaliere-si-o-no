import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/* ── Build-time constants ────────────────────────────────────────── */

/* ── Content-hash manifest disabled 2026-04-28 (see plugins block) ──── */
// import { initManifest, saveManifest, getManifest } from './build-plugins/contentHash';

/* ── Custom build plugins (extracted for clarity) ─────────────── */
import { buildIdPlugin } from './build-plugins/buildIdPlugin';
import { seoBlogShardIndexPlugin, RESOLVED_SEO_BLOG_SHARD_INDEX_ID } from './build-plugins/seoBlogShardIndexPlugin';
import { newsTickerDataPlugin } from './build-plugins/newsTickerDataPlugin';
import { staticScriptsPlugin } from './build-plugins/staticScriptsPlugin';
import { asyncCssPlugin } from './build-plugins/asyncCssPlugin';
import { prepareOutDirPlugin } from './build-plugins/prepareOutDirPlugin';
import { preloadLocalePlugin } from './build-plugins/preloadLocalePlugin';
import { ogPagesPlugin } from './build-plugins/ogPagesPlugin';
import { jobsSeoPagesPlugin } from './build-plugins/jobsSeoPagesPlugin';
import jobOgImagesPlugin from './build-plugins/jobOgImagesPlugin';
import { jobRecencyPagesPlugin } from './build-plugins/jobRecencyPagesPlugin';
import { jobSectorPagesPlugin } from './build-plugins/jobSectorPagesPlugin';
import { orphanQueryLandingPlugin } from './build-plugins/orphanQueryLandingPlugin';
import { relatedSearchClustersPlugin } from './build-plugins/relatedSearchClustersPlugin';
import { staticPagesPlugin } from './build-plugins/staticPagesPlugin';
import { sitemapAliasPlugin } from './build-plugins/sitemapAliasPlugin';
import { legacyRedirectsPlugin } from './build-plugins/legacyRedirectsPlugin';
import { cantonOrphanRedirectsPlugin } from './build-plugins/cantonOrphanRedirectsPlugin';
import { calculatorLegacyAliasPlugin } from './build-plugins/calculatorLegacyAliasPlugin';
import { jobOrphanBridgePlugin } from './build-plugins/jobOrphanBridgePlugin';
import { adFilterSafeChunkName } from './build-plugins/shared/adFilterSafeChunkName';
import { matchBlogBodyChunkLocale, buildBlogBodyChunkFileName } from './build-plugins/shared/blogBodyChunkNaming';
import { SPA_ENTRY_JS_FILENAME } from './build-plugins/shared/spaEntryFilenames';
import { locationHubBridgePlugin } from './build-plugins/locationHubBridgePlugin';
import { companyHubBridgePlugin } from './build-plugins/companyHubBridgePlugin';
import { legacyAliasPlugin } from './build-plugins/legacyAliasPlugin';
import { cfHot404BridgePlugin } from './build-plugins/cfHot404BridgePlugin';
import { jobCanonRedirectMapPlugin } from './build-plugins/jobCanonRedirectMapPlugin';
// flatHtmlRedirectPlugin + hreflangPostprocessPlugin imports retained for
// type re-exports / unit tests. Their plugin exports are now consumed
// internally by `postWalkCoordinatorPlugin` (single-walk perf optimization).
import { flatHtmlRedirectPlugin } from './build-plugins/flatHtmlRedirectPlugin';
import { hreflangPostprocessPlugin } from './build-plugins/hreflangPostprocessPlugin';
import { postWalkCoordinatorPlugin } from './build-plugins/postWalkCoordinatorPlugin';
import { blogImageCdnFinalizePlugin } from './build-plugins/blogImageCdnFinalizePlugin';
import {
  writeRegistryResetPlugin,
  writeRegistryReportPlugin,
} from './build-plugins/writeRegistryLifecyclePlugin';
import { buildMemoryGuardPlugin } from './build-plugins/shared/buildMemoryGuard';
// flatContentPlugin removed — all plugins now write real content to both index.html and flat .html directly,
// then flatHtmlRedirectPlugin (post-processor) converts each flat .html with a sibling /index.html into a
// 301-style redirect bridge to close ~3.2k Semrush hreflang↔canonical conflicts.
import { llmsTxtPlugin } from './build-plugins/llmsTxtPlugin';
import { adminDataPlugin } from './build-plugins/adminDataPlugin';
import { crawlerRegistryPlugin } from './build-plugins/crawlerRegistryPlugin';
import { localeJobsSplitPlugin } from './build-plugins/localeJobsSplitPlugin';
import { expiredJobsSplitPlugin } from './build-plugins/expiredJobsSplitPlugin';
import { jobsJsonDistCleanupPlugin } from './build-plugins/jobsJsonDistCleanupPlugin';
import { webpPlugin } from './build-plugins/webpPlugin';
import { pdfWhitepapersPlugin } from './build-plugins/pdfWhitepapersPlugin';
import { salaryHubPlugin } from './build-plugins/salaryHubPlugin';
import { affiliateRedirectPlugin } from './build-plugins/affiliateRedirectPlugin';
import { fuelDailyPagesPlugin } from './build-plugins/fuelDailyPagesPlugin';
import { weatherCityPagesPlugin } from './build-plugins/weatherCityPagesPlugin';
import { weatherAlertPagesPlugin } from './build-plugins/weatherAlertPagesPlugin';
import { weatherBorderWaitFusionPlugin } from './build-plugins/weatherBorderWaitFusionPlugin';
import { weeklyEmployersPlugin } from './build-plugins/weeklyEmployersPlugin';
import { jobMarketSnapshotPlugin } from './build-plugins/jobMarketSnapshotPlugin';
import { salaryStatsChCantonPages } from './build-plugins/salaryStatsChCantonPages';
import { professionCantonLandings } from './build-plugins/professionCantonLandings';
import { salaryProfessionCantonPages } from './build-plugins/salaryProfessionCantonPages';
import { salaryBadgeEmbedPlugin } from './build-plugins/salaryBadgeEmbedPlugin';
import { professionCityLandings } from './build-plugins/professionCityLandings';
import { professionCityLinksPlugin } from './build-plugins/professionCityLinksPlugin';
import { healthPremiumsLandingPlugin } from './build-plugins/healthPremiumsLandingPlugin';
import { exchangeRatePagesPlugin } from './build-plugins/exchangeRatePagesPlugin';
// blogContextualLinksPlugin import retained for tests / type re-exports.
// Its plugin export is now consumed internally by `postWalkCoordinatorPlugin`.
import { blogContextualLinksPlugin } from './build-plugins/blogContextualLinksPlugin';
import { borderWaitPagesPlugin } from './build-plugins/borderWaitPagesPlugin';
import { marketReportPlugin } from './build-plugins/marketReportPlugin';
import { selfCertificationFormsPlugin } from './build-plugins/selfCertificationFormsPlugin';
import { communicationsPagePlugin } from './build-plugins/communicationsPagePlugin';
import { annualReportPlugin } from './build-plugins/annualReportPlugin';
import { borderWaitMapPlugin } from './build-plugins/borderWaitMapPlugin';
import { borderMunicipalityPagesPlugin } from './build-plugins/borderMunicipalityPagesPlugin';
import { fiscalMunicipalityPagesPlugin } from './build-plugins/fiscalMunicipalityPagesPlugin';
import { fiscalMunicipalityLinksPlugin } from './build-plugins/fiscalMunicipalityLinksPlugin';
import { frenchBorderMunicipalityPagesPlugin } from './build-plugins/frenchBorderMunicipalityPagesPlugin';
import { frenchBorderMunicipalityLinksPlugin } from './build-plugins/frenchBorderMunicipalityLinksPlugin';
import { germanBorderMunicipalityPagesPlugin } from './build-plugins/germanBorderMunicipalityPagesPlugin';
import { germanBorderMunicipalityLinksPlugin } from './build-plugins/germanBorderMunicipalityLinksPlugin';
import { liechtensteinBorderMunicipalityPagesPlugin } from './build-plugins/liechtensteinBorderMunicipalityPagesPlugin';
import { liechtensteinBorderMunicipalityLinksPlugin } from './build-plugins/liechtensteinBorderMunicipalityLinksPlugin';
import { austrianBorderMunicipalityPagesPlugin } from './build-plugins/austrianBorderMunicipalityPagesPlugin';
import { austrianBorderMunicipalityLinksPlugin } from './build-plugins/austrianBorderMunicipalityLinksPlugin';
import { eventsSeoPagesPlugin } from './build-plugins/eventsSeoPagesPlugin';
import { nursingLandingsPlugin } from './build-plugins/nursingLandingsPlugin';
import { healthFacilitiesPlugin } from './build-plugins/healthFacilitiesPlugin';
import { healthFacilitiesLinksPlugin } from './build-plugins/healthFacilitiesLinksPlugin';
import { careerLandingsPlugin } from './build-plugins/careerLandingsPlugin';
import { professionLandingsPlugin } from './build-plugins/professionLandingsPlugin';
import { professionLandingsLinksPlugin } from './build-plugins/professionLandingsLinksPlugin';
import { professionCantonLandingsLinksPlugin } from './build-plugins/professionCantonLandingsLinksPlugin';
import { salaryProfessionCantonLinksPlugin } from './build-plugins/salaryProfessionCantonLinksPlugin';
import { salaryHubIndexLinkPlugin } from './build-plugins/salaryHubIndexLinkPlugin';
import { sectorHubLinksPlugin } from './build-plugins/sectorHubLinksPlugin';
import { comparisonsHubPlugin } from './build-plugins/comparisonsHubPlugin';
import { comparisonsHubLinksPlugin } from './build-plugins/comparisonsHubLinksPlugin';
import { costOfLivingLandingsPlugin } from './build-plugins/costOfLivingLandingsPlugin';
import { frontalierePillarPlugin } from './build-plugins/frontalierePillarPlugin';
import { faqHubPlugin } from './build-plugins/faqHubPlugin';
import { publisherAdPagesPlugin } from './build-plugins/publisherAdPagesPlugin';
import { publisherAdLinksPlugin } from './build-plugins/publisherAdLinksPlugin';
import { employerProfilePagesPlugin } from './build-plugins/employerProfilePagesPlugin';
import { employerProfilePagesLinksPlugin } from './build-plugins/employerProfilePagesLinksPlugin';
import { faqHubLinksPlugin } from './build-plugins/faqHubLinksPlugin';
import { frSalaireNetLandingPlugin } from './build-plugins/frSalaireNetLandingPlugin';
import { holidaysLandingsPlugin } from './build-plugins/holidaysLandingsPlugin';
import { seoHeroCardsPlugin } from './build-plugins/seoHeroCardsPlugin';
import { topicClusterHubsPlugin } from './build-plugins/topicClusterHubsPlugin';
import { bfsSalaryLandingsPlugin } from './build-plugins/bfsSalaryLandingsPlugin';
import { bfsSalaryLinksPlugin } from './build-plugins/bfsSalaryLinksPlugin';
import { minimumWageLandingsPlugin } from './build-plugins/minimumWageLandingsPlugin';
import { sectionPagesPlugin } from './build-plugins/sectionPagesPlugin';
import { precompressHtmlPlugin } from './build-plugins/precompressHtmlPlugin';
import { localeTableCompletenessPlugin } from './build-plugins/localeTableCompletenessPlugin';
import { withProfile, profileSummaryPlugin } from './build-plugins/profilePlugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ── Build modes ─────────────────────────────────────────────────
 * npm run build → FAST_BUILD=1, esbuild, skip SEO plugins (~30-45s, dev)
 * npm run build:ci → esbuild + ALL plugins + 8GB heap (~3-4 min, prepush)
 * npm run build:prod → terser + ALL plugins + 8GB heap (~5-6 min, deploy)
 * ─────────────────────────────────────────────────────────────── */

/* ================================================================
 * Vite configuration
 * ================================================================ */
export default defineConfig(({ mode }) => {
 // Read env inside the callback so tests/callers that mutate FAST_BUILD
 // after importing this module still see the current value.
 const isFastBuild = !!process.env.FAST_BUILD;
 const env = loadEnv(mode, '.', '');
 // Build the unified plugin list, then wrap every entry in `withProfile()`
 // and append `profileSummaryPlugin()` last so it emits the total line
 // after every wrapped closeBundle has resolved. Profiling is on by default;
 // set BUILD_PROFILE=0 to opt out for local one-offs.
 const allPlugins: Plugin[] = [
 // ── Core plugins (always run, including FAST_BUILD) ──────────
 // `@vitejs/plugin-react` returns multiple plugins (one per React feature
 // such as Fast Refresh, JSX runtime). Spread so each is wrapped
 // individually by withProfile() — most lack a closeBundle hook so the
 // wrapper just returns them unchanged.
 ...react(),
 prepareOutDirPlugin(__dirname),
 // Emits `virtual:seo-blog-shard-index` (blog-<id> → seo-blog shard ordinal).
 // Core, not SEO-gated: services/seoService.ts imports the virtual module, so
 // a FAST_BUILD that skipped this plugin would fail to resolve it. Costs one
 // read of the eight seo-blog*.ts sources per build.
 seoBlogShardIndexPlugin(__dirname),
 // ── Content-hash manifest DISABLED 2026-04-28 ────────────────
 // Was bootstrapping a SHA256 manifest used by WriteCollector to skip
 // writes for unchanged HTML across builds. Net ROI in this repo turned
 // out negative: ~80% of deploys are auto-blog/auto-translate which
 // touch data files → manifest skip can't fire. Cost was +30-60s per
 // build (SHA256 on 220k+ files in WriteCollector). When getManifest()
 // returns null (no init), WriteCollector falls through to plain writes.
 // To re-enable: restore the bootstrap+finalize plugins below and the
 // `Cache content-hash manifest` step in .github/workflows/deploy.yml.
 buildIdPlugin(__dirname),
 staticScriptsPlugin(__dirname),
 asyncCssPlugin(),
 // Slim homepage news-ticker payload (5 latest articles, per-locale title+slug)
 // served in place of data/news-ticker-data.ts — dev + FAST_BUILD + full builds.
 newsTickerDataPlugin(__dirname),
 preloadLocalePlugin(__dirname),
 sitemapAliasPlugin(__dirname),
 adminDataPlugin(__dirname),
 crawlerRegistryPlugin(__dirname),
 localeJobsSplitPlugin(__dirname), // SPA reads per-locale job JSONs at runtime
 expiredJobsSplitPlugin(__dirname), // slim expired index + per-entry detail (vs 11MB-gz monolith)
 // Strip the 88 MB master `dist/data/jobs.json` after every build plugin
 // has consumed `public/data/jobs.json`. Frees ~88 MB on the deploy
 // artifact (10 GB GH Pages cap). `enforce: 'post'` runs after every
 // other closeBundle.
 jobsJsonDistCleanupPlugin(__dirname),
 affiliateRedirectPlugin(__dirname),
 // ── SEO plugins (skipped when FAST_BUILD=1) ──────────────────
 ...(isFastBuild ? [] : [
 // Asserts every hand-authored Record<Locale, Record<Key, string>>
 // slug table used to build a canonical URL is fully populated (issue
 // #3608 item 2 sibling fix). Cheap in-memory check with no I/O; placed
 // first in this block so a missing entry fails the build immediately
 // instead of after the heavy SEO plugins have already run.
 localeTableCompletenessPlugin(),
 ogPagesPlugin(__dirname),
 // MUST stay BEFORE jobsSeoPagesPlugin. `jobsSeoPagesPlugin` does
 // `await employerProfilesFlushed` (#5273) to link each job ad at the
 // evergreen `/aziende/<slug>/` hub, and deploy.yml runs the build with
 // SEQUENTIAL_PROFILE=1, which makes profilePlugin mark EVERY closeBundle
 // `sequential: true`. Under sequential hooks a signal can only ever travel
 // FORWARD in this array: registered after its consumer, the producer never
 // gets to run, the await never settles, the event loop drains and node
 // exits 0 — a green build missing every page after the deadlock (#5330).
 // tests/build-plugin-order.test.ts derives this constraint from the
 // sources, so a new cross-plugin `await` is checked here automatically.
 employerProfilePagesPlugin(__dirname),
 jobsSeoPagesPlugin(__dirname),
 // Per-job OG images (1200×630) for FB/LinkedIn previews. Reads
 // data/jobs.json + company-logos-manifest, writes dist/og/jobs/<slug>.png.
 // Idempotent: existing PNGs are re-used. ~1-2 min to render 2100 jobs.
 ...(process.env.SKIP_JOB_OG_IMAGES !== '1' ? [jobOgImagesPlugin()] : []),
 jobRecencyPagesPlugin(__dirname),
 jobSectorPagesPlugin(__dirname),
 fuelDailyPagesPlugin(__dirname),
 weatherCityPagesPlugin(__dirname),
 weatherAlertPagesPlugin(__dirname),
 weeklyEmployersPlugin(__dirname),
 jobMarketSnapshotPlugin(__dirname),
 salaryStatsChCantonPages(__dirname),
 professionCantonLandings(__dirname),
 // Salary-intent profession×canton landings (#4461) — /stipendio-{prof}-{canton}/
 // (+ locale variants) for the 8 professions with a real median preset, non-TI
 // cantons, gated on the same MIN_JOBS floor as professionCantonLandings.
 salaryProfessionCantonPages(__dirname),
 // Embeddable "stipendio medio {professione}" badge snapshot (epic #4472):
 // dist/embed/salary-badge-data.json from data/profession-salary-medians.json.
 salaryBadgeEmbedPlugin(__dirname),
 professionCityLandings(__dirname),
 healthPremiumsLandingPlugin(__dirname),
 // CHF/EUR exchange vertical (epic #4452): hub + amount long-tail pages
 // from the committed data/exchange-rate-snapshot.json (daily cron refresh).
 exchangeRatePagesPlugin(__dirname),
 borderWaitPagesPlugin(__dirname),
 weatherBorderWaitFusionPlugin(__dirname),
 marketReportPlugin(__dirname),
 selfCertificationFormsPlugin(__dirname),
 communicationsPagePlugin(__dirname),
 // Sprint 5.1 — annual salary report. Must run AFTER jobMarketSnapshotPlugin
 // so the job-market hub HTML is already on disk when we patch it with a
 // callout linking to the annual report.
 annualReportPlugin(__dirname),
 borderWaitMapPlugin(__dirname),
 nursingLandingsPlugin(__dirname),
 // Health-facilities hub (epic #4455): one page per Swiss hospital/clinic
 // employer with live matched jobs (full JobPosting schema) + noindex
 // below-floor bridges. Self-mapped in searchConsoleCompat.ts.
 healthFacilitiesPlugin(__dirname),
 // AE-2 — 4 career quick-win landings × 4 locales = 16 HTML outputs. Uses
 // concorsi.ti.ch snapshot + SECO AVG registry for cited content.
 careerLandingsPlugin(__dirname),
 // AE-3 — 10 profession landings × 4 locales = 40 HTML outputs. Mirrors the
 // nursing plugin contract (staticOverlay + seoContentOutsideRoot).
 professionLandingsPlugin(__dirname),
 // AE-4 — cost-of-living city landings (6 cities × 4 locales = 24 HTML).
 // FSO + ISTAT public data; Place + LocalBusiness JSON-LD + sitemap.
 costOfLivingLandingsPlugin(__dirname),
 // Pillar hub "frontaliere" (#3393) — 4 static pages + sitemap-frontaliere-pillar.xml.
 frontalierePillarPlugin(__dirname),
 // AE-7 — comparisons hub (static HTML × 4 locales + sitemap-comparisons.xml).
 // Must run AFTER annualReportPlugin so the CSV path referenced in the
 // DataDownload JSON-LD (/data/jobs-salary-aggregate.csv) already exists.
 comparisonsHubPlugin(__dirname),
 // AE-5 — 100-Q&A FAQ hub (static HTML × 4 locales + FAQPage JSON-LD with
 // 100 mainEntity). Pure content plugin: no data dependency, so it can
 // run in any order after the other landing plugins.
 faqHubPlugin(__dirname),
 publisherAdPagesPlugin(__dirname),
 // employerProfilePagesPlugin used to sit here. It moved up next to
 // ogPagesPlugin because jobsSeoPagesPlugin awaits its flush signal — see
 // the comment there. It reads no other plugin's dist output (only
 // data/employer-profiles.json + the jobs corpus) and writes only the
 // `/aziende/<slug>/` namespace, so nothing else depends on this slot.
 // FR landing — single page targeting "calcul salaire net suisse frontalier"
 // (Semrush CH 880/mo). Self-contained: no router edit, no SPA route. The
 // static HTML serves SEO/first-paint; SPA fallback hydrates on /fr/calculer-salaire/.
 frSalaireNetLandingPlugin(__dirname),
 // #4480 — frontaliere public-holiday landings: Ticino/CH calendar + CH-vs-IT
 // comparison (2 page types × 4 locales = 8 static pages). Dataset-driven
 // (data/seo/frontaliere-holidays.json). Curated set, no floor loop.
 holidaysLandingsPlugin(__dirname),
 // #5001 — article topic hubs. One hub per (section × locale × curated
 // topic); membership derived from the #5107 TF-IDF similarity graph, names
 // curated (a component cannot name itself — see topicClusters.ts). Topics
 // under the article floor emit a noindex,follow bridge at the same URL, so
 // no topic URL ever 404s.
 topicClusterHubsPlugin(__dirname),
 // #4481 — BFS salary-by-age / salary-by-education landings (5 ages + 4
 // education levels × 4 locales = 36 static pages). Dataset-driven
 // (data/seo/bfs-salary-by-age.json). CTA → net-salary calculator.
 bfsSalaryLandingsPlugin(__dirname),
 // #4479 — Swiss minimum-wage landings: hub + 5 canton pages (GE/BS/JU/NE/TI)
 // + CCL sector page (7 page types × 4 locales = 28 static pages).
 // Dataset-driven (data/seo/swiss-minimum-wage.json). Curated set, no floor
 // loop. End-of-content multiplex on the hub (index) page only.
 minimumWageLandingsPlugin(__dirname),
 // C3 — Google News compliance section pages: 7 topic areas × 4 locales = 28
 // static HTML aggregator pages listing the latest 20 matching blog
 // articles per section. Static-only (no SPA route, no nav-tab impact).
 ...(process.env.SKIP_SECTION_PAGES !== '1' ? [sectionPagesPlugin()] : []),
 orphanQueryLandingPlugin(__dirname),
 // staticPagesPlugin emits the section-landing index.html files
 // (/cerca-lavoro-ticino/, /en/find-jobs-ticino/, etc.) that
 // relatedSearchClustersPlugin's `injectHubLinkIntoSectionLanding`
 // patches downstream. Must run BEFORE the cluster plugin in sequential
 // mode (the new always-on default) — otherwise the cluster plugin
 // logs "section landing missing — skipping hub link injection" and
 // the link from each section landing to the cluster paginated hub is
 // never written, breaking the hub's inbound link graph.
 staticPagesPlugin(__dirname),
 // Border-municipality pages patch the static hub after it has been flushed.
 // Keep this after staticPagesPlugin: with sequential closeBundle hooks,
 // running it earlier would wait on a signal that cannot be resolved yet.
 borderMunicipalityPagesPlugin(__dirname),
 // Per-comune FISCAL guide pages ("tasse frontaliere residente a {comune}:
 // vecchio vs nuovo regime", epic #4482). Self-contained (own dist paths,
 // no hub patch), so ordering vs staticPagesPlugin is not load-bearing.
 // Default-on; escape hatch SKIP_FISCAL_MUNICIPALITY_PAGES=1.
 fiscalMunicipalityPagesPlugin(__dirname),
 // Per-comune FRANCE border-municipality pages ("vivere a {commune} e
 // lavorare in Svizzera", issue #4545 — Genève/Vaud/Neuchâtel/Jura/Valais
 // corridor, first of the FR/DE/AT/LI rollout). Self-contained (own dist
 // paths, no hub patch), same ordering rationale as fiscalMunicipalityPagesPlugin.
 // Default-on; escape hatch SKIP_FRENCH_BORDER_MUNICIPALITY_PAGES=1.
 frenchBorderMunicipalityPagesPlugin(__dirname),
 // Per-comune GERMANY border-municipality pages (issue #4882 — Baden-
 // Württemberg corridor, second of the FR/DE/LI rollout). Same
 // self-contained pattern as frenchBorderMunicipalityPagesPlugin above.
 // Default-on; escape hatch SKIP_GERMAN_BORDER_MUNICIPALITY_PAGES=1.
 germanBorderMunicipalityPagesPlugin(__dirname),
 // Per-Gemeinde LIECHTENSTEIN border-municipality pages (issue #4884, third
 // of the FR/DE/LI rollout). Same self-contained pattern as
 // frenchBorderMunicipalityPagesPlugin above.
 // Default-on; escape hatch SKIP_LIECHTENSTEIN_BORDER_MUNICIPALITY_PAGES=1.
 liechtensteinBorderMunicipalityPagesPlugin(__dirname),
 // Per-Gemeinde AUSTRIA border-municipality pages (issue #4883, fourth of
 // the FR/DE/AT/LI rollout — Vorarlberg/Tirol corridor). Same
 // self-contained pattern as frenchBorderMunicipalityPagesPlugin above.
 // Unlike its siblings this regime has NO favourable frontalieri tax
 // treatment (abrogated 2006/2007) — see austrianBorderMunicipalityData.ts.
 // Default-on; escape hatch SKIP_AUSTRIAN_BORDER_MUNICIPALITY_PAGES=1.
 austrianBorderMunicipalityPagesPlugin(__dirname),
 // Per-comune Ticino events pages (issue #2963). Same post-staticPages
 // ordering as borderMunicipalityPagesPlugin: it patches the
 // /vivere-in-ticino/ hubs after they are flushed and awaits
 // staticPagesFlushed, so it must run after staticPagesPlugin. Default-on;
 // escape hatch SKIP_EVENTS_PAGES=1.
 eventsSeoPagesPlugin(__dirname),
 // Related-search cluster landings (B2). Self-gated by
 // SKIP_RELATED_SEARCH_CLUSTERS=1 (no outer wrapper needed); skipped in
 // typical agent sessions via .claude/settings.json env block.
 relatedSearchClustersPlugin(__dirname),
 salaryHubPlugin(__dirname),
 legacyRedirectsPlugin(__dirname),
 // Canton-orphan redirects: emits HTTP-200 canonical-bridge HTML at every
 // /cerca-lavoro-{canton}/{foreign-editorial-slug}/ combination (TI long-
 // form slug under a non-TI section, etc.) → that canton's canonical
 // slug. Closes the GSC 404 trail left by the pre-Phase-8d URL structure
 // when Google had indexed cross-canton slug nestings. Pair with the SPA
 // router redirect in services/router.ts (shipped PR #200) which handles
 // the same URLs on hydrated navigation. Plugin is collision-safe.
 ...(process.env.SKIP_CANTON_ORPHAN_REDIRECTS !== '1' ? [cantonOrphanRedirectsPlugin()] : []),
 // Calculator legacy-alias pages: recover the 22 GSC 404s for
 // `/{en|de|fr}/calcola-stipendio/?reddito=...` historical share-links.
 // Emits 200 HTML with locale-canonical `<link rel="canonical">` + an
 // inline pre-hydration script that rewrites the URL bar to the locale-
 // canonical slug before the SPA boots — preserves `?reddito=...` so
 // urlStateService prefills the simulation. No 301, AdSense fires.
 calculatorLegacyAliasPlugin(__dirname),
 // Job-orphan bridge: recover the 92 GSC 404s for /{locale}/{section}/{slug}/
 // job-detail URLs (Cohort 1). Reads classified entries from
 // data/gsc-job-orphans.json (refreshed via scripts/ingest-gsc-job-orphans.mjs).
 // Matched orphans (21): canonical + JS history.replaceState to current job.
 // Expired orphans (71): canonical to section landing + "annuncio scaduto"
 // body with extracted company hint. No 301, AdSense fires on both. The
 // plugin is collision-safe — skips writing if another plugin already
 // produced real content at the target path (e.g. a re-activated job).
 jobOrphanBridgePlugin(__dirname),
 // Location-hub bridge: recover the 60 GSC 404s for /{locale}/{section}/{loc-prefix}-{city}/
 // city-filter URLs (Cohort 2). Reads classified entries from
 // data/gsc-location-hubs.json (refreshed via scripts/ingest-gsc-location-hubs.mjs).
 // Matched (38): canonical=self + SPA hydrates JobBoard with location filter
 // applied (real listings + AdSense). Unmatched (22): canonical→section
 // landing + "località non disponibile" body. Collision-safe.
 locationHubBridgePlugin(__dirname),
 // Company-hub bridge: recover the 15 GSC 404s for /{locale}/{section}/{comp-prefix}-{company}/
 // employer-filter URLs (Cohort 4). Reads classified entries from
 // data/gsc-company-hubs.json (refreshed via scripts/ingest-gsc-company-hubs.mjs).
 // Matched (4): canonical=self + SPA hydrates JobBoard with company filter.
 // Unmatched (11): canonical→section + "azienda non disponibile" body.
 companyHubBridgePlugin(__dirname),
 // Legacy-alias bridge: recover the 35 GSC 404s spread across 9 small misc
 // sub-cohorts (Cohort 5). Reads classified entries from data/legacy-aliases.json
 // (refreshed via scripts/build-legacy-aliases.mjs). Each entry is `matched`
 // (canonical+replaceState to live page) or `unmatched` (canonical→hub fallback).
 // Covers: blogLocaleMismatch (17), blogITMissing (1), fuelStation (8),
 // fuelLocaleAlias (1), jobLegacySection (2), legacySectionAlt (2),
 // subSlugOnly (1), localePrefixed (2), weeklyEmployersDeep (1).
 legacyAliasPlugin(__dirname),
 // CF-hot 404 bridges: recover the non-Ticino job-detail 404s Cloudflare
 // confirms are actually hit (data/cf-hot-404s.json, ranked + capped). The
 // bounded, traffic-targeted replacement for the reverted full-symmetry
 // sweep (#2000 → OOM → #2031). enforce:'post' + existsSync gap-fill +
 // LAST in the page-emitter order (after jobOrphan/hub/legacyAlias) so it
 // only fills paths with no richer page. Hard MAX_EMIT cap in the plugin.
 cfHot404BridgePlugin(__dirname),
 // Sharded slug→canonical-section map (dist/job-canon/*.json) read by
 // public/404.html + the Worker to redirect canton-drift orphans to their real
 // page at request time — the only way to recover the EXISTING orphans (not
 // enumerable statically: a 404 URL has no GSC impressions). Pin kills NEW
 // drift; this recovers the indexed ones. Emitted here into dist, then pushed
 // to the CDN and deleted from dist by the deploy CDN-offload step (same as
 // /data and /og — see deploy-it-pages-prep.sh + offload-generated-images-cdn.mjs).
 jobCanonRedirectMapPlugin(__dirname),
 // AE-7 — after static pages are written, inject a contextual link into
 // a handful of parent pages so the comparisons hub has inbound links
 // from homepage + confronti hub + salary pillars. Idempotent.
 comparisonsHubLinksPlugin(__dirname),
 // AE-5 caveat — inject contextual link from each locale guide hub root
 // (/guida-frontaliere/ + 3 locale twins) into the 100-Q&A FAQ hub.
 // Uses enforce: 'post' so it runs after staticPagesPlugin writes the
 // guide-hub HTML. Idempotent via `data-ae5-faq-link`.
 faqHubLinksPlugin(__dirname),
 // AE-3 — inject profession-landings list into /cerca-lavoro-ticino/ (+ 3 locale
 // job-board hubs) and a healthcare/education cross-link into the
 // /vita-in-ticino/oss-svizzera/ pillar. Must run after staticPagesPlugin so
 // the target HTML files already exist on disk. Idempotent via
 // `data-ae3-profession-links` marker.
 professionLandingsLinksPlugin(__dirname),
 // Health-facilities #4458 — inject a "facilities hiring near you" block into
 // the nursing landings (viceversa link direction). Awaits nursingLandings +
 // healthFacilities flush signals. Idempotent via `data-health-facility-links`.
 healthFacilitiesLinksPlugin(__dirname),
 // Per-canton profession landings orphan fix — inject a "jobs by canton and
 // profession" block into each locale HTML sitemap page (main-nav reachable)
 // so the ~332 /lavoro-{canton}-{role}/ pages reach BFS depth ≤ 3 instead of
 // shipping unreachable (audit:max-bfs-depth hard-fail). Awaits explicit
 // signals from professionCantonLandings (emitted paths) + staticPagesPlugin
 // (sitemap-page HTML). Idempotent via `data-profession-cantons-links`.
 professionCantonLandingsLinksPlugin(__dirname),
 // Fiscal-municipality guide orphan fix — inject a link to the fiscal hub
 // (FISCAL_HUB_PATH, which already links every above-floor comune below it)
 // into each locale's HTML sitemap page (main-nav reachable) so the whole
 // sitemap-comuni-fiscale.xml shard (33/33 URLs) reaches BFS depth ≤ 3
 // instead of shipping fully unreachable (audit:max-bfs-depth hard-fail).
 // Awaits explicit signals from fiscalMunicipalityPagesPlugin (hub paths) +
 // staticPagesPlugin (sitemap-page HTML). Idempotent via
 // `data-fiscal-municipalities-links`.
 fiscalMunicipalityLinksPlugin(__dirname),
 // France border-municipality hub orphan fix — inject a link to the France
 // hub (FRENCH_HUB_PATH, which already links every above-floor commune
 // below it) into each locale's HTML sitemap page (main-nav reachable) so
 // the whole sitemap-comuni-francia.xml shard reaches BFS depth ≤ 3 instead
 // of shipping fully unreachable (audit:max-bfs-depth hard-fail). Awaits
 // explicit signals from frenchBorderMunicipalityPagesPlugin (hub paths) +
 // staticPagesPlugin (sitemap-page HTML). Idempotent via
 // `data-french-border-municipalities-links`.
 frenchBorderMunicipalityLinksPlugin(__dirname),
 // Germany border-municipality hub orphan fix — same pattern as the France
 // links plugin above, injecting a link to GERMAN_HUB_PATH into each
 // locale's HTML sitemap page. Awaits explicit signals from
 // germanBorderMunicipalityPagesPlugin (hub paths) + staticPagesPlugin
 // (sitemap-page HTML). Idempotent via
 // `data-german-border-municipalities-links`.
 germanBorderMunicipalityLinksPlugin(__dirname),
 // Liechtenstein border-municipality hub orphan fix — same pattern as the
 // France links plugin above, injecting a link to LIECHTENSTEIN_HUB_PATH
 // into each locale's HTML sitemap page. Awaits explicit signals from
 // liechtensteinBorderMunicipalityPagesPlugin (hub paths) + staticPagesPlugin
 // (sitemap-page HTML). Idempotent via
 // `data-liechtenstein-border-municipalities-links`.
 liechtensteinBorderMunicipalityLinksPlugin(__dirname),
 // Austria border-municipality hub orphan fix — same pattern as the
 // Germany/Liechtenstein links plugins above, injecting a link to
 // AUSTRIAN_HUB_PATH into each locale's HTML sitemap page. Awaits explicit
 // signals from austrianBorderMunicipalityPagesPlugin (hub paths) +
 // staticPagesPlugin (sitemap-page HTML). Idempotent via
 // `data-austrian-border-municipalities-links`.
 austrianBorderMunicipalityLinksPlugin(__dirname),
 // Employer-profile pages orphan fix — inject an "Aziende in Svizzera" block
 // into each locale's HTML sitemap page (main-nav reachable) so the ~468
 // /aziende/{slug}/ pages reach BFS depth ≤ 3 instead of shipping fully
 // unreachable (audit:max-bfs-depth, 468/468 orphaned). Awaits explicit
 // signals from employerProfilePagesPlugin (emitted profiles) +
 // staticPagesPlugin (sitemap-page HTML). Idempotent via
 // `data-employer-profiles-links`.
 employerProfilePagesLinksPlugin(__dirname),
 // Profession×city orphan fix — inject a "jobs by city and profession" block
 // into each locale's HTML sitemap page (main-nav reachable) so the ~208
 // /lavoro-{city}-{role}/ pages reach BFS depth ≤ 3 instead of shipping
 // 62.65% unreachable (audit:max-bfs-depth). Awaits explicit signals from
 // professionCityLandings (emitted paths) + staticPagesPlugin (sitemap-page
 // HTML). Idempotent via `data-profession-cities-links`.
 professionCityLinksPlugin(__dirname),
 // BFS salary-by-age/education orphan fix — inject a "salary by age and
 // education" block into each locale's HTML sitemap page (main-nav
 // reachable) so the ~20 stipendio-svizzera-{age|education}/ pages reach
 // BFS depth ≤ 3 instead of shipping 55.56% unreachable
 // (audit:max-bfs-depth). Awaits explicit signals from bfsSalaryLandingsPlugin
 // (emitted paths) + staticPagesPlugin (sitemap-page HTML). Idempotent via
 // `data-bfs-salary-links`.
 bfsSalaryLinksPlugin(__dirname),
 // Publisher-ad (paid) orphan fix — inject a "sponsored listings" CTA into
 // each locale's HTML sitemap page (main-nav reachable) so /lavoro/{slug}/
 // ad pages reach BFS depth ≤ 3 instead of shipping fully unreachable
 // (audit:max-bfs-depth) — revenue-critical paid content. Awaits explicit
 // signals from publisherAdPagesPlugin (emitted ads) + staticPagesPlugin
 // (sitemap-page HTML). Idempotent via `data-publisher-ads-links`.
 publisherAdLinksPlugin(__dirname),
 // Salary-intent profession×canton orphan fix — inject a "salary by profession
 // and canton" block into each locale HTML sitemap page (main-nav reachable) so
 // the /stipendio-{prof}-{canton}/ pages reach BFS depth ≤ 2 instead of shipping
 // unreachable (audit:max-bfs-depth). Awaits signals from
 // salaryProfessionCantonPages (emitted paths) + staticPagesPlugin (sitemap HTML).
 salaryProfessionCantonLinksPlugin(__dirname),
 // Salary-hub orphan fix — patch the calculator hub (/calcola-stipendio/
 // + 3 locale twins) with a single anchor to /calcola-stipendio/scenari/
 // (and locale variants) so BFS from `/` reaches every one of the 1 732
 // salary-hub scenario pages. Awaits explicit signals from
 // staticPagesPlugin + salaryHubPlugin to avoid the parallel-flush race
 // that previously bit professionLandingsLinksPlugin.
 salaryHubIndexLinkPlugin(__dirname),
 // Sector-hub orphan fix — patch the 4 job-board hubs (/cerca-lavoro-ticino/
 // + 3 locale twins) with an <aside> linking the ~15 highest-demand sector
 // hubs so the ~37 orphaned sector hubs (live but ~0 internal links) become
 // reachable at depth 2 from the homepage's most-crawled page. Awaits explicit
 // signals from staticPagesPlugin (hub HTML) + jobSectorPagesPlugin (the 49
 // sector landings) to avoid the parallel-flush race. Idempotent via the
 // `data-sector-hub-links` marker — coexists with the AE-3 profession block.
 sectorHubLinksPlugin(__dirname),
 llmsTxtPlugin(__dirname),
 webpPlugin(__dirname),
 pdfWhitepapersPlugin(__dirname),
 // ── Post-walk coordinator (perf optimization 2026-04-28) ─────
 // Replaces three sequential dist/**/*.html walkers that used to run
 // here independently:
 //   1. blogContextualLinksPlugin (~9.5s)  — inject 1-2 contextual
 //      links per blog article HTML.
 //   2. flatHtmlRedirectPlugin (~52.7s)    — convert every flat .html
 //      with a sibling /index.html into a redirect bridge.
 //   3. hreflangPostprocessPlugin (~76.3s) — strip broken
 //      <link rel="alternate" hreflang> tags whose target is absent.
 //
 // All three are now applied during ONE shared walk inside the
 // coordinator: each HTML file is opened once, transformed in order,
 // and written at most once. The legacy plugin exports remain
 // available for unit tests but MUST NOT be registered here — that
 // would duplicate the work and erase the perf win.
 postWalkCoordinatorPlugin(__dirname, { baseUrl: 'https://frontaliereticino.ch' }),
 // T2.6 disabled — brotli quality 11 on 220k HTML files added 5-10 min to
 // build for negligible benefit: GitHub Pages serves through Fastly which
 // gzips on-the-fly, and pre-compressed siblings aren't preferentially
 // served by Pages. Net ROI: -4 to -9 min per deploy. Disabled 2026-04-28.
 // To re-enable safely, lower BROTLI_PARAM_QUALITY to 4-5 and skip files
 // <10KB so only large pages benefit. Code retained at
 // build-plugins/precompressHtmlPlugin.ts for future revival.
 // precompressHtmlPlugin(__dirname),
 ]),
 // Blog-image CDN offload — MUST be last: rewrites full /images/blog refs in
 // emitted HTML/XML to jsDelivr (SHA-pinned), guards against any survivor,
 // then deletes the full images from dist (keeps 480w thumbnails). Runs after
 // postWalkCoordinator so it sees the final HTML. ~224 MB off the Pages artifact.
 blogImageCdnFinalizePlugin(__dirname),
 // ── Content-hash manifest finalize DISABLED 2026-04-28 ──────
 // Paired with the disabled bootstrap above. Code retained for future
 // revival once a use-case (rollback / hotfix-only chains) emerges.
 ];
 // When ASSET_CDN is set (deploy build only), emit absolute CDN URLs for all
 // bundler assets (JS/CSS/chunks) so dist/assets can be offloaded to the
 // frontaliere-cdn Pages site. Unset (dev / normal builds) → renderBuiltUrl is
 // absent → 100% default base-relative behaviour, nothing changes.
 const ASSET_CDN = (process.env.ASSET_CDN || '').trim().replace(/\/+$/, '');

 return {
 base: '/',
 ...(ASSET_CDN
 ? {
 experimental: {
 renderBuiltUrl(filename: string, { type }: { type: 'asset' | 'public' }) {
 // Only BUNDLER-emitted assets (dist/assets/* JS/CSS/chunks) are pushed to the
 // CDN, so only those may be rebased. public/* files — favicon, PWA icons,
 // manifest.webmanifest, fonts, llms.txt, AND /.well-known/ai-plugin.json — are
 // copied as-is and MUST stay same-origin: they are NOT on the CDN (rebasing
 // 404s every page) and several are origin-bound by contract (AI/plugin
 // discovery + the PWA manifest & its icons). #1293's blanket rebase sent them
 // all to the CDN (incl. a malformed `${ASSET_CDN}//fonts/…` double slash from
 // @font-face url(/fonts/…)); scoping to `type === 'asset'` fixes the whole class.
 // public assets → same-origin absolute (matches the pre-#1293 base '/' default;
 // strip a leading slash so a CSS `url(/fonts/…)` filename doesn't double it).
 if (type !== 'asset') return `/${filename.replace(/^\/+/, '')}`;
 // bundler assets → CDN, same output-relative path (e.g. "assets/index-abc.js").
 return `${ASSET_CDN}/${filename.replace(/^\/+/, '')}`;
 },
 },
 }
 : {}),
 server: {
 port: 3000,
 host: '0.0.0.0',
 },
 plugins: [
 // Campiona RSS del processo + MemAvailable dell'host per tutta la build e la
 // fa fallire con un errore NOMINATO prima che l'host la uccida (#5369 §7).
 // Sta per primo perche' il suo `buildStart` deve armare il campionatore prima
 // che qualunque altra fase allochi: la fase piu' costosa (~7,7 GB di RSS) e'
 // il bundle di Vite/Rollup, che finisce PRIMA del primo closeBundle. Un
 // campionatore armato solo in closeBundle non la vedrebbe mai.
 // Soglie e derivazione: build-plugins/shared/buildMemoryGuard.ts.
 buildMemoryGuardPlugin(),
 // Resets the cross-plugin write registry at every buildStart so watch-mode
 // rebuilds don't carry stale claims. Must run before any plugin's closeBundle
 // starts calling claim() — i.e. before every EMITTER. `buildMemoryGuardPlugin`
 // above is the only entry that precedes it and it never calls claim() (it
 // writes dist/build-memory-peak.json with plain fs, outside the registry), so
 // the invariant this comment protects is unchanged. Also configures the
 // per-build content dump dir from WRITE_COLLISION_DUMP env var.
 writeRegistryResetPlugin({ rootDir: __dirname }),
 ...allPlugins.map(withProfile),
 // #5001 punto 2 — genera le hero card richieste dalle famiglie SEO statiche.
 // DEVE stare dopo `allPlugins`: legge il registry che `renderSeoHeroImage`
 // riempie mentre gli emettitori scrivono il markup, quindi se girasse prima
 // troverebbe il registry vuoto (e lo dice, invece di non fare nulla in
 // silenzio).
 seoHeroCardsPlugin(__dirname),
 // Prints the collision summary and writes dist/.write-collisions.json after
 // every other plugin's closeBundle has flushed. enforce/order makes it the
 // last hook in the chain.
 writeRegistryReportPlugin({ rootDir: __dirname }),
 // Emits `[profile-total] ...` after every wrapped plugin's closeBundle has
 // resolved. No-op when BUILD_PROFILE=0.
 profileSummaryPlugin(),
 ],
 // No build-time `define`: nothing volatile is injected into the bundle.
 // Build id / commit hash are emitted as dist/build-id.txt + commit-hash.txt
 // (buildIdPlugin) and read at RUNTIME. Baking them via define put a fresh
 // value into the entry chunk every build → new content hash → every one of
 // ~1.28M prerendered pages re-referenced a new /assets/index-<hash>.js →
 // ~100% deploy churn. Keep the bundle deterministic so incremental sync works.
 resolve: {
 alias: {
 '@': path.resolve(__dirname, '.'),
 }
 },
 build: {
 emptyOutDir: false,
 // Emitted alongside the bundle in dist/assets so PostHog can resolve
 // minified stack frames (owner decision 2026-08-15, issue #5607: exposing
 // reconstructible source is accepted in exchange for automatic exception
 // diagnosis — PostHog was getting frames=[] on every in-app-webview
 // RangeError because no .map existed to fetch). dist/assets is copied to
 // the CDN as-is (scripts/lib/deploy-it-pages-prep.sh) so no separate
 // upload step is needed — the .map rides along with its .js/.css.
 sourcemap: true,
 // Rollup's default reportCompressedSize gzip-compresses EVERY emitted JS/CSS
 // chunk purely to print the "gzip: NN kB" console column. With the many vendor
 // splits + per-locale data chunks that's pure wall-time on the build job for
 // zero emitted bytes (console output only). Disable it.
 reportCompressedSize: false,
 // seo-blog-N.ts chunks are pure data objects (~600kB raw, ~66kB gzip).
 // They exceed the default 500kB warning but gzip well and load lazily.
 // This limit acknowledges that data chunks behave differently from code chunks.
 chunkSizeWarningLimit: 600,
 // Fast build: esbuild (10-100x faster), production: terser (saves ~56KB)
 minify: isFastBuild ? 'esbuild' : 'terser',
 ...(!isFastBuild && {
 terserOptions: {
 compress: {
 passes: 2,
 drop_console: false,
 },
 format: {
 comments: false,
 },
 },
 }),
 modulePreload: {
 // Prevent eager preloading of lazy vendor chunks (charts, pdf, etc.)
 resolveDependencies: (filename, deps, { hostId, hostType }) => {
 // Only preload deps for the entry point, not for lazy chunks
 // Filter out vendor chunks and locale data that should only load on demand
 return deps.filter(dep => 
 !dep.includes('vendor-charts') && 
 !dep.includes('vendor-pdf') &&
 !dep.includes('vendor-maps') &&
 // `deps` are EMITTED filenames, which chunkFileNames runs through
 // adFilterSafeChunkName (firebase→fdb, #2971). Match the sanitized token so
 // this no-preload guard keeps suppressing the heavy firebase vendor chunks
 // instead of silently letting them eager-preload on the entry. Sanitising the
 // logical name inline keeps it readable AND rename-proof if the alias changes.
 !dep.includes(adFilterSafeChunkName('vendor-firebase')) &&
 !dep.includes('shared-services') &&
 !dep.includes('vendor-icons') &&
 !dep.includes('seoService') &&
 !dep.includes('seo-pages') &&
 !dep.includes('seo-blog') &&
 !dep.includes('seo-landing') &&
 !dep.includes('blog-') &&
 // Filter locale data chunks (it, en, de, fr) — loaded on demand by i18n
 !/\b(it|en|de|fr)-[A-Za-z0-9]/.test(dep)
 );
 },
 },
 rollupOptions: {
 output: {
 // Keep CROSS-CHUNK EXPORT NAMES stable across builds (root-cause fix for the
 // version-skew TypeError class, e.g. "ls(...).then is not a function" on
 // articles). With stable filenames (below) but the Rollup default
 // `minifyInternalExports: true`, internal-only exports are minified to single
 // letters (`export { lt as m }`) REASSIGNED every build by pure minifier
 // ordering. A client holding a previously-cached importer chunk
 // (`import { m as ls }`) then binds the OLD letter to whatever the FRESH
 // dependency chunk now exports under `m` → the symbol is the wrong value →
 // TypeError at call time. This is the cross-chunk-binding twin of the
 // blog-body FILENAME keying fix below ("a cached slug2.js could mean a
 // different locale after a reorder"). `false` emits the real semantic export
 // name (`export { loadArticleBody }` ↔ `import { loadArticleBody as ls }`), so
 // the binding stays correct no matter how the minifier re-letters locals.
 // Cost: marginally larger chunks (export identifiers no longer shortened) —
 // acceptable vs. white-screen crashes during the ~600s post-deploy skew window.
 // REVERT TRIGGER: build:ci OOMs only on the SSG walk, not on this Rollup output
 // option, so this is low-risk; but the bundle-size delta is not measured
 // pre-merge (full local build OOMs). If the next deploy's build fails or the
 // CDN bundle size regresses materially, revert this single line.
 minifyInternalExports: false,
 // STABLE filenames (no content-hash) for EVERY JS chunk and CSS sheet.
 //
 // History: the entry was stabilized first (index-entry.js, #1615 — Vite chunk
 // hashes are circularly interconnected entry→App→leaf→App, so ANY bundled-module
 // change cascaded to the entry hash → all ~1.28M prerendered pages re-referenced
 // a new /assets/index-<hash>.js → ~80%/deploy churn, measured). Then the entry
 // CSS (index.css, #1810 — a rotated hash 404'd from HTML still cached under the
 // superseded name). The remaining hashed names had the SAME two costs at smaller
 // scale and bought nothing in return:
 // - The prerendered pages also embed <link rel="modulepreload"> for App,
 //   i18n, it-core, it-calculator and vendor-react (staticPagesPlugin /
 //   preloadLocalePlugin / ogPagesPlugin): one hash rotation there re-churned
 //   every page despite the stable entry.
 // - Cached HTML referencing a rotated hash 404s once the old file is pruned
 //   from the CDN (grace 7d) — the #1810 outage class, still open for chunks.
 // - The classic argument FOR hashes — far-future immutable caching — does not
 //   exist in this serving stack: GitHub Pages ignores public/_headers and
 //   serves EVERYTHING (hashed or not) with `cache-control: max-age=600` + ETag
 //   (verified live 2026-06-12). Hashed names therefore only rotated URLs
 //   (cold CDN/browser cache on every deploy) without ever being immutable.
 // With stable names every URL persists across deploys: unchanged files
 // revalidate to 304s, changed files re-download — and pages stay byte-identical.
 // Worst case after a deploy is a ≤600s stale window (same as the entry today).
 // - Chunk discovery in build plugins goes through
 //   build-plugins/shared/chunkFiles.ts (stable name first, legacy hashed
 //   fallback); the entry filename itself is the SPA_ENTRY_JS_FILENAME
 //   constant imported above, shared with build-plugins/spaBundleResolver.ts
 //   and seoPageShell.ts (shared/spaEntryFilenames.ts) so none of them can
 //   drift from what's configured here.
 // - CACHE: see public/_headers — /assets/* revalidates (max-age=600); nothing
 //   may be served immutable now that names are stable.
 // - CDN offload (deploy.yml) cp -r's all of dist/assets and the additive merge
 //   (cp -n) never overwrites a freshly-built file → the stable names always
 //   carry the new bytes; prune-cdn-assets GCs the legacy hashed generations.
 entryFileNames: `assets/${SPA_ENTRY_JS_FILENAME}`,
 chunkFileNames: (chunk) => {
 // Per-article blog-body modules share their basename across the 4 locale
 // dirs — BOTH the legacy services/locales path and the real,
 // symlink-resolved packages/articles/content path (issue #4881 Fase 6 —
 // see build-plugins/shared/blogBodyChunkNaming.ts for the full rationale
 // and why both shapes must match). Without a qualifier Rollup dedups the
 // colliding output names by appending a counter (slug2.js = en, slug3.js
 // = fr, …) whose locale mapping is pure iteration order — semantically
 // unkeyed under stable-name caching (a cached slug2.js could mean a
 // different locale after a reorder). Key them by locale instead:
 // <slug>.<locale>.js / <slug>.ch.<locale>.js (dot separator: can't be
 // confused with a real slug suffix nor with the legacy `-<hash8>` shape
 // the CDN janitor prunes).
 const m = matchBlogBodyChunkLocale(chunk.facadeModuleId);
 // Neutralise ad-filter trigger substrings in the stable basename so a
 // blocked/surrogated first-party chunk can't link-break the page (issue
 // #2971). No-op for names without a tracker keyword; Rollup rewrites every
 // internal import reference to the emitted name, so the rename is consistent.
 const safe = adFilterSafeChunkName(chunk.name ?? '');
 return buildBlogBodyChunkFileName(safe, m);
 },
 assetFileNames: (assetInfo) => {
 const n = assetInfo.name || (assetInfo.names && assetInfo.names[0]) || '';
 // All stylesheets get stable names (entry index.css + per-chunk CSS).
 // Non-CSS bundler assets (images/fonts imported from JS) keep the hash:
 // their basenames can collide across source dirs and nothing in the
 // prerendered HTML references them, so rotation is free there.
 if (n.endsWith('.css')) return 'assets/[name][extname]';
 return 'assets/[name]-[hash][extname]';
 },
 manualChunks(id) {
 // Name the blog SEO shard index explicitly. Without this Rollup derives the
 // filename from the virtual module id and emits `_virtual_seo-blog-shard-index.js`;
 // chunk names are stable (no hash), so that spelling would become a permanent
 // public URL. Still a standalone chunk either way — it is dynamic-only, imported
 // by seoService just for `blog-*` keys.
 if (id === RESOLVED_SEO_BLOG_SHARD_INDEX_ID) return 'seo-blog-shard-index';
 // Vendor chunks for node_modules
 if (id.includes('node_modules')) {
 // Keep React core separate so it's not pulled into vendor-charts by recharts
 if (id.includes('/react-dom/') || id.includes('/scheduler/')) return 'vendor-react';
 if (id.includes('/react/')) return 'vendor-react';
 // Force all lucide-react icons into a single 'icons' chunk that loads with the entry.
 // Without this, Rollup creates 39+ tiny shared chunks (one per icon shared between
 // lazy components), each requiring a separate HTTP request on mobile 3G.
 if (id.includes('lucide-react')) return 'vendor-icons';
 // Split Firebase aggressively by product area to keep each chunk
 // below warning thresholds while preserving lazy-load behavior.
 if (id.includes('node_modules/firebase/')) {
 if (id.includes('/firestore')) return 'vendor-firebase-firestore';
 if (id.includes('/auth')) return 'vendor-firebase-auth';
 if (id.includes('/analytics')) return 'vendor-firebase-analytics';
 if (id.includes('/performance')) return 'vendor-firebase-performance';
 if (id.includes('/remote-config')) return 'vendor-firebase-remote-config';
 if (id.includes('/app-check')) return 'vendor-firebase-appcheck';
 return 'vendor-firebase-core';
 }
 if (id.includes('node_modules/@firebase/')) {
 if (id.includes('/firestore')) return 'vendor-firebase-firestore';
 if (id.includes('/auth')) return 'vendor-firebase-auth';
 if (id.includes('/analytics')) return 'vendor-firebase-analytics';
 if (id.includes('/performance')) return 'vendor-firebase-performance';
 if (id.includes('/remote-config')) return 'vendor-firebase-remote-config';
 if (id.includes('/app-check')) return 'vendor-firebase-appcheck';
 return 'vendor-firebase-core';
 }
 if (id.includes('node_modules/idb')) return 'vendor-firebase-core';
 if (id.includes('recharts') || id.includes('d3-') || id.includes('victory-')) return 'vendor-charts';
 if (id.includes('leaflet') || id.includes('react-leaflet')) return 'vendor-maps';
 if (id.includes('jspdf') || id.includes('jspdf-autotable')) return 'vendor-pdf';
 }
 // Split i18n translations into a parallel-loaded chunk
 if (id.includes('services/i18n')) return 'i18n';
 // Consolidate small shared services into one chunk to reduce HTTP requests.
 // These are tiny modules (<4KB each) used across multiple lazy components.
 if (
 id.includes('services/popupQueue') ||
 id.includes('services/exchangeRateService') ||
 id.includes('services/affiliateService') ||
 id.includes('services/recaptchaService')
 ) return 'shared-services';
 // NOTE: trafficService is NOT in shared-services because it imports firebase,
 // which would pull heavy firebase vendor chunks into the initial load via
 // InputCard → popupQueue → shared-services → trafficService → firebase.
 // NOTE: services/locales/* are NOT assigned here — they stay as separate lazy chunks
 // NOTE: seoService is NOT assigned here — it's dynamically imported from App.tsx
 },
 },
 },
 },
 };
});
