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
import { staticPagesPlugin } from './build-plugins/staticPagesPlugin';
import { sitemapAliasPlugin } from './build-plugins/sitemapAliasPlugin';
import { legacyRedirectsPlugin } from './build-plugins/legacyRedirectsPlugin';
// flatContentPlugin removed — all plugins now write real content to both index.html and flat .html directly
import { llmsTxtPlugin } from './build-plugins/llmsTxtPlugin';
import { adminDataPlugin } from './build-plugins/adminDataPlugin';
import { crawlerRegistryPlugin } from './build-plugins/crawlerRegistryPlugin';
import { localeJobsSplitPlugin } from './build-plugins/localeJobsSplitPlugin';
import { webpPlugin } from './build-plugins/webpPlugin';
import { pdfWhitepapersPlugin } from './build-plugins/pdfWhitepapersPlugin';
import { salaryHubPlugin } from './build-plugins/salaryHubPlugin';
import { affiliateRedirectPlugin } from './build-plugins/affiliateRedirectPlugin';

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
 staticPagesPlugin(__dirname),
 salaryHubPlugin(__dirname),
 legacyRedirectsPlugin(__dirname),
 llmsTxtPlugin(__dirname),
 webpPlugin(__dirname),
 pdfWhitepapersPlugin(__dirname),
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
