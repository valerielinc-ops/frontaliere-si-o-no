import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/* ── Build-time constants ────────────────────────────────────────── */
import { BUILD_ID, COMMIT_HASH, SHORT_COMMIT_HASH } from './build-plugins/constants';

/* ── Content-hash manifest disabled 2026-04-28 (see plugins block) ──── */
// import { initManifest, saveManifest, getManifest } from './build-plugins/contentHash';

/* ── Custom build plugins (extracted for clarity) ─────────────── */
import { buildIdPlugin } from './build-plugins/buildIdPlugin';
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
import { calculatorLegacyAliasPlugin } from './build-plugins/calculatorLegacyAliasPlugin';
// flatHtmlRedirectPlugin + hreflangPostprocessPlugin imports retained for
// type re-exports / unit tests. Their plugin exports are now consumed
// internally by `postWalkCoordinatorPlugin` (single-walk perf optimization).
import { flatHtmlRedirectPlugin } from './build-plugins/flatHtmlRedirectPlugin';
import { hreflangPostprocessPlugin } from './build-plugins/hreflangPostprocessPlugin';
import { postWalkCoordinatorPlugin } from './build-plugins/postWalkCoordinatorPlugin';
import {
  writeRegistryResetPlugin,
  writeRegistryReportPlugin,
} from './build-plugins/writeRegistryLifecyclePlugin';
// flatContentPlugin removed — all plugins now write real content to both index.html and flat .html directly,
// then flatHtmlRedirectPlugin (post-processor) converts each flat .html with a sibling /index.html into a
// 301-style redirect bridge to close ~3.2k Semrush hreflang↔canonical conflicts.
import { llmsTxtPlugin } from './build-plugins/llmsTxtPlugin';
import { adminDataPlugin } from './build-plugins/adminDataPlugin';
import { crawlerRegistryPlugin } from './build-plugins/crawlerRegistryPlugin';
import { localeJobsSplitPlugin } from './build-plugins/localeJobsSplitPlugin';
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
import { healthPremiumsLandingPlugin } from './build-plugins/healthPremiumsLandingPlugin';
// blogContextualLinksPlugin import retained for tests / type re-exports.
// Its plugin export is now consumed internally by `postWalkCoordinatorPlugin`.
import { blogContextualLinksPlugin } from './build-plugins/blogContextualLinksPlugin';
import { borderWaitPagesPlugin } from './build-plugins/borderWaitPagesPlugin';
import { marketReportPlugin } from './build-plugins/marketReportPlugin';
import { annualReportPlugin } from './build-plugins/annualReportPlugin';
import { borderWaitMapPlugin } from './build-plugins/borderWaitMapPlugin';
import { nursingLandingsPlugin } from './build-plugins/nursingLandingsPlugin';
import { careerLandingsPlugin } from './build-plugins/careerLandingsPlugin';
import { professionLandingsPlugin } from './build-plugins/professionLandingsPlugin';
import { professionLandingsLinksPlugin } from './build-plugins/professionLandingsLinksPlugin';
import { salaryHubIndexLinkPlugin } from './build-plugins/salaryHubIndexLinkPlugin';
import { comparisonsHubPlugin } from './build-plugins/comparisonsHubPlugin';
import { comparisonsHubLinksPlugin } from './build-plugins/comparisonsHubLinksPlugin';
import { costOfLivingLandingsPlugin } from './build-plugins/costOfLivingLandingsPlugin';
import { faqHubPlugin } from './build-plugins/faqHubPlugin';
import { faqHubLinksPlugin } from './build-plugins/faqHubLinksPlugin';
import { frSalaireNetLandingPlugin } from './build-plugins/frSalaireNetLandingPlugin';
import { sectionPagesPlugin } from './build-plugins/sectionPagesPlugin';
import { precompressHtmlPlugin } from './build-plugins/precompressHtmlPlugin';
import { withProfile, profileSummaryPlugin } from './build-plugins/profilePlugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ── Build modes ─────────────────────────────────────────────────
 * npm run build → FAST_BUILD=1, esbuild, skip SEO plugins (~30-45s, dev)
 * npm run build:ci → esbuild + ALL plugins + 8GB heap (~3-4 min, prepush)
 * npm run build:prod → terser + ALL plugins + 8GB heap (~5-6 min, deploy)
 * ─────────────────────────────────────────────────────────────── */
const isFastBuild = !!process.env.FAST_BUILD;

/* ================================================================
 * Vite configuration
 * ================================================================ */
export default defineConfig(({ mode }) => {
 const env = loadEnv(mode, '.', '');
 // Build the unified plugin list, then wrap every entry in `withProfile()`
 // and append `profileSummaryPlugin()` last so it emits the total line
 // after every wrapped closeBundle has resolved. `withProfile` is a no-op
 // when BUILD_PROFILE !== '1' (zero overhead in normal local builds).
 const allPlugins: Plugin[] = [
 // ── Core plugins (always run, including FAST_BUILD) ──────────
 // `@vitejs/plugin-react` returns multiple plugins (one per React feature
 // such as Fast Refresh, JSX runtime). Spread so each is wrapped
 // individually by withProfile() — most lack a closeBundle hook so the
 // wrapper just returns them unchanged.
 ...react(),
 prepareOutDirPlugin(__dirname),
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
 asyncCssPlugin(),
 preloadLocalePlugin(__dirname),
 sitemapAliasPlugin(__dirname),
 adminDataPlugin(__dirname),
 crawlerRegistryPlugin(__dirname),
 localeJobsSplitPlugin(__dirname), // SPA reads per-locale job JSONs at runtime
 affiliateRedirectPlugin(__dirname),
 // ── SEO plugins (skipped when FAST_BUILD=1) ──────────────────
 ...(isFastBuild ? [] : [
 ogPagesPlugin(__dirname),
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
 healthPremiumsLandingPlugin(__dirname),
 borderWaitPagesPlugin(__dirname),
 weatherBorderWaitFusionPlugin(__dirname),
 marketReportPlugin(__dirname),
 // Sprint 5.1 — annual salary report. Must run AFTER jobMarketSnapshotPlugin
 // so the job-market hub HTML is already on disk when we patch it with a
 // callout linking to the annual report.
 annualReportPlugin(__dirname),
 borderWaitMapPlugin(__dirname),
 nursingLandingsPlugin(__dirname),
 // AE-2 — 4 career quick-win landings × 4 locales = 16 HTML outputs. Uses
 // concorsi.ti.ch snapshot + SECO AVG registry for cited content.
 careerLandingsPlugin(__dirname),
 // AE-3 — 10 profession landings × 4 locales = 40 HTML outputs. Mirrors the
 // nursing plugin contract (staticOverlay + seoContentOutsideRoot).
 professionLandingsPlugin(__dirname),
 // AE-4 — cost-of-living city landings (6 cities × 4 locales = 24 HTML).
 // FSO + ISTAT public data; Place + LocalBusiness JSON-LD + sitemap.
 costOfLivingLandingsPlugin(__dirname),
 // AE-7 — comparisons hub (static HTML × 4 locales + sitemap-comparisons.xml).
 // Must run AFTER annualReportPlugin so the CSV path referenced in the
 // DataDownload JSON-LD (/data/jobs-salary-aggregate.csv) already exists.
 comparisonsHubPlugin(__dirname),
 // AE-5 — 100-Q&A FAQ hub (static HTML × 4 locales + FAQPage JSON-LD with
 // 100 mainEntity). Pure content plugin: no data dependency, so it can
 // run in any order after the other landing plugins.
 faqHubPlugin(__dirname),
 // FR landing — single page targeting "calcul salaire net suisse frontalier"
 // (Semrush CH 880/mo). Self-contained: no router edit, no SPA route. The
 // static HTML serves SEO/first-paint; SPA fallback hydrates on /fr/calculer-salaire/.
 frSalaireNetLandingPlugin(__dirname),
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
 // Related-search cluster landings (B2). Self-gated by
 // SKIP_RELATED_SEARCH_CLUSTERS=1 (no outer wrapper needed); skipped in
 // typical agent sessions via .claude/settings.json env block.
 relatedSearchClustersPlugin(__dirname),
 salaryHubPlugin(__dirname),
 legacyRedirectsPlugin(__dirname),
 // Calculator legacy-alias pages: recover the 22 GSC 404s for
 // `/{en|de|fr}/calcola-stipendio/?reddito=...` historical share-links.
 // Emits 200 HTML with locale-canonical `<link rel="canonical">` + an
 // inline pre-hydration script that rewrites the URL bar to the locale-
 // canonical slug before the SPA boots — preserves `?reddito=...` so
 // urlStateService prefills the simulation. No 301, AdSense fires.
 calculatorLegacyAliasPlugin(__dirname),
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
 // Salary-hub orphan fix — patch the calculator hub (/calcola-stipendio/
 // + 3 locale twins) with a single anchor to /calcola-stipendio/scenari/
 // (and locale variants) so BFS from `/` reaches every one of the 1 732
 // salary-hub scenario pages. Awaits explicit signals from
 // staticPagesPlugin + salaryHubPlugin to avoid the parallel-flush race
 // that previously bit professionLandingsLinksPlugin.
 salaryHubIndexLinkPlugin(__dirname),
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
 // ── Content-hash manifest finalize DISABLED 2026-04-28 ──────
 // Paired with the disabled bootstrap above. Code retained for future
 // revival once a use-case (rollback / hotfix-only chains) emerges.
 ];
 return {
 base: '/',
 server: {
 port: 3000,
 host: '0.0.0.0',
 },
 plugins: [
 // Resets the cross-plugin write registry at every buildStart so watch-mode
 // rebuilds don't carry stale claims. Must be FIRST so it runs before any
 // plugin's closeBundle starts calling claim(). Also configures the per-build
 // content dump dir from WRITE_COLLISION_DUMP env var.
 writeRegistryResetPlugin({ rootDir: __dirname }),
 ...allPlugins.map(withProfile),
 // Prints the collision summary and writes dist/.write-collisions.json after
 // every other plugin's closeBundle has flushed. enforce/order makes it the
 // last hook in the chain.
 writeRegistryReportPlugin({ rootDir: __dirname }),
 // Emits `[profile-total] ...` after every wrapped plugin's closeBundle has
 // resolved. No-op when BUILD_PROFILE !== '1'.
 profileSummaryPlugin(),
 ],
 define: {
 // No secrets injected at build time — all sensitive keys come from Firebase Remote Config at runtime
 __BUILD_ID__: JSON.stringify(BUILD_ID),
 __COMMIT_HASH__: JSON.stringify(COMMIT_HASH),
 __SHORT_COMMIT_HASH__: JSON.stringify(SHORT_COMMIT_HASH),
 },
 resolve: {
 alias: {
 '@': path.resolve(__dirname, '.'),
 }
 },
 build: {
 emptyOutDir: false,
 // No error tracking service (Sentry etc.) — sourcemaps not needed
 sourcemap: false,
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
 !dep.includes('vendor-firebase') &&
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
 manualChunks(id) {
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
