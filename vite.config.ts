import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/* ── Build-time constants ────────────────────────────────────────── */
import { BUILD_ID, COMMIT_HASH, SHORT_COMMIT_HASH } from './build-plugins/constants';

/* ── Custom build plugins (extracted for clarity) ─────────────── */
import { buildIdPlugin } from './build-plugins/buildIdPlugin';
import { asyncCssPlugin } from './build-plugins/asyncCssPlugin';
import { prepareOutDirPlugin } from './build-plugins/prepareOutDirPlugin';
import { preloadLocalePlugin } from './build-plugins/preloadLocalePlugin';
import { ogPagesPlugin } from './build-plugins/ogPagesPlugin';
import { jobsSeoPagesPlugin } from './build-plugins/jobsSeoPagesPlugin';
import { jobRecencyPagesPlugin } from './build-plugins/jobRecencyPagesPlugin';
import { jobSectorPagesPlugin } from './build-plugins/jobSectorPagesPlugin';
import { orphanQueryLandingPlugin } from './build-plugins/orphanQueryLandingPlugin';
import { staticPagesPlugin } from './build-plugins/staticPagesPlugin';
import { sitemapAliasPlugin } from './build-plugins/sitemapAliasPlugin';
import { legacyRedirectsPlugin } from './build-plugins/legacyRedirectsPlugin';
import { flatHtmlRedirectPlugin } from './build-plugins/flatHtmlRedirectPlugin';
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
import { weeklyEmployersPlugin } from './build-plugins/weeklyEmployersPlugin';
import { jobMarketSnapshotPlugin } from './build-plugins/jobMarketSnapshotPlugin';
import { healthPremiumsLandingPlugin } from './build-plugins/healthPremiumsLandingPlugin';
import { blogContextualLinksPlugin } from './build-plugins/blogContextualLinksPlugin';
import { borderWaitPagesPlugin } from './build-plugins/borderWaitPagesPlugin';
import { marketReportPlugin } from './build-plugins/marketReportPlugin';
import { annualReportPlugin } from './build-plugins/annualReportPlugin';
import { borderWaitMapPlugin } from './build-plugins/borderWaitMapPlugin';
import { nursingLandingsPlugin } from './build-plugins/nursingLandingsPlugin';
import { careerLandingsPlugin } from './build-plugins/careerLandingsPlugin';
import { professionLandingsPlugin } from './build-plugins/professionLandingsPlugin';
import { professionLandingsLinksPlugin } from './build-plugins/professionLandingsLinksPlugin';
import { comparisonsHubPlugin } from './build-plugins/comparisonsHubPlugin';
import { comparisonsHubLinksPlugin } from './build-plugins/comparisonsHubLinksPlugin';
import { costOfLivingLandingsPlugin } from './build-plugins/costOfLivingLandingsPlugin';
import { faqHubPlugin } from './build-plugins/faqHubPlugin';
import { faqHubLinksPlugin } from './build-plugins/faqHubLinksPlugin';
import { frSalaireNetLandingPlugin } from './build-plugins/frSalaireNetLandingPlugin';

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
 return {
 base: '/',
 server: {
 port: 3000,
 host: '0.0.0.0',
 },
 plugins: [
 // ── Core plugins (always run, including FAST_BUILD) ──────────
 react(),
 prepareOutDirPlugin(__dirname),
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
 jobRecencyPagesPlugin(__dirname),
 jobSectorPagesPlugin(__dirname),
 fuelDailyPagesPlugin(__dirname),
 weeklyEmployersPlugin(__dirname),
 jobMarketSnapshotPlugin(__dirname),
 healthPremiumsLandingPlugin(__dirname),
 borderWaitPagesPlugin(__dirname),
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
 orphanQueryLandingPlugin(__dirname),
 staticPagesPlugin(__dirname),
 salaryHubPlugin(__dirname),
 legacyRedirectsPlugin(__dirname),
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
 llmsTxtPlugin(__dirname),
 webpPlugin(__dirname),
 pdfWhitepapersPlugin(__dirname),
 // A6: inject contextual links from blog articles to feature hubs.
 // MUST run after ogPagesPlugin + jobsSeoPagesPlugin so the target
 // HTML files already exist on disk when closeBundle fires.
 blogContextualLinksPlugin(__dirname),
 // Post-processor — runs LAST, after every other plugin has written its
 // flat .html files. Converts each `<path>.html` that has a sibling
 // `<path>/index.html` into a 301-style redirect bridge so crawlers
 // never see two canonical-conflicting copies of the same content.
 flatHtmlRedirectPlugin(__dirname, { baseUrl: 'https://frontaliereticino.ch' }),
 ]),
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
