/**
 * Shared constants for Vite build plugins.
 *
 * BUILD_ID: per-build timestamp. Emitted to dist/build-id.txt by buildIdPlugin
 * and read at runtime (staleness checks). NOT injected as a Vite `define` —
 * baking it into the bundle changed the entry hash every build → ~100% page
 * churn (see vite.config define removal).
 *
 * Honors `process.env.DEPLOY_BUILD_ID` when set, so a multi-runner deploy
 * (the per-locale MATRIX build) can pass ONE canonical id to every shard build
 * — otherwise each runner's `Date.now()` would diverge and the IT shard's
 * build-id.txt (the one GitHub Pages serves + the one staged into the
 * sitemaps-bundle for wait-for-pages-propagation.mjs) could differ from the
 * sitemaps-bundle copy, breaking the propagation gate. The monolith deploy
 * leaves the env unset → behaviour is byte-identical to the old timestamp.
 * The override is sanitised to digits only so it stays a numeric stamp,
 * preserving the `>=` (monotonic) comparison in wait-for-pages-propagation.mjs.
 * COMMIT_HASH / SHORT_COMMIT_HASH: build commit. Emitted to dist/commit-hash.txt
 * and read at runtime (version badge fetches it). Also NOT a `define`, same reason.
 * BASE_URL: canonical site origin used across all static-page generators.
 *
 * BUILD_DATE_STAMP: UTC "today" (YYYY-MM-DD) derived from BUILD_ID rather than a
 * fresh `new Date()` (#5911). On the matrix deploy the it/en/de/fr shards are 4
 * independent, multi-hour processes; a plugin that computed `new Date()` itself
 * at whatever wall-clock moment it happened to run could see a different UTC day
 * on different shards, which is dangerous for any generator that uses "today" to
 * decide WHETHER to emit a page (not just to stamp `lastmod`) — a page emitted on
 * one shard's date and skipped on another's leaves the other shards' unconditional
 * hreflang alternates pointing at a target that was never built. BUILD_ID is
 * already minted once per deploy run in matrix-setup and shared via
 * DEPLOY_BUILD_ID, so deriving the date from it keeps every shard's "today"
 * identical for free, with the same monolith-build fallback behaviour as BUILD_ID.
 */

import { execSync } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BOT_UA_PATTERNS } from '../services/botPatterns';
// Single source of truth for the ads-consent storage contract (#5842). Imported
// rather than re-typed so the inline static loader below and the SPA gate in
// AdSenseBanner/GptAdSlot cannot drift apart: the emitted loader string is
// derived from these constants at build time. Safe to import here — every DOM
// access in that module is behind a `typeof window === 'undefined'` guard, so
// module scope is inert under Node.
import { ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED } from '../services/adsConsent';
import { BENIGN_MESSAGES, THIRD_PARTY_STACK_ORIGINS } from '../services/posthog-error-filter';
import { WEBKIT_ORIGIN_REDACTED_FRAME, ORIGIN_REDACTED_MIN_FRAMES } from '../services/benignErrorPatterns';
import {
  AD_BLOCKER_TRIGGER_PATTERN_SOURCE,
  CALL_TIME_SKEW_PATTERNS,
  CHUNK_LOAD_ERROR_PATTERN_SOURCE,
  MODULE_LINK_SKEW_PATTERNS,
} from '../services/resilientImport';
import { adSlotHtml } from './lib/adSlotHtml';
import { REDIRECT_STUB_MARKER } from './shared/redirectStubMarker';
import { clampMetaDescription } from './shared/titleSuffix';
import { ROBOTS_INDEX_ENHANCED_CONTENT } from './shared/robotsDirective';

/**
 * Regex-source strings interpolated into SELF_HEAL_SCRIPT_CONTENT below,
 * generated at BUILD TIME (this file runs under Node/Vite, not the browser)
 * from resilientImport.ts's exported pattern lists. This is the fix for
 * issue #3216 item 1: the emitted early-boot.js script previously carried a
 * HAND-COPIED subset of these patterns that had drifted (missing 'Importing
 * a module script failed', WebKit's generic module-load-failure wording) —
 * generating the source from the shared arrays instead makes that drift
 * impossible by construction (AGENTS.md §Non-Negotiables #6).
 */
const CALL_TIME_SKEW_SOURCE = CALL_TIME_SKEW_PATTERNS.map((re) => re.source).join('|');
const MODULE_LINK_SKEW_SOURCE = MODULE_LINK_SKEW_PATTERNS.map((re) => re.source).join('|');
const CHUNK_LOAD_ERROR_SOURCE = CHUNK_LOAD_ERROR_PATTERN_SOURCE;
const AD_BLOCKER_SOURCE = AD_BLOCKER_TRIGGER_PATTERN_SOURCE;

/**
 * Same regex-source-generation technique as above, applied to the PostHog
 * `before_send` benign-noise filter (issue #3406/#3407 fix): the static-page
 * PostHog init snippet below (POSTHOG_INIT_CONTENT) is plain externalised JS
 * that cannot `import` services/posthog-error-filter.ts, so its filter logic
 * is generated from the SAME source arrays the React/SPA init
 * (services/posthog.ts) uses. Before this fix, POSTHOG_INIT_CONTENT had NO
 * `before_send` at all — a sibling-drift bug (AGENTS.md §Non-Negotiables #6):
 * PR #2733 (2026-06-22) added the benign-noise deny-list only to the SPA
 * path, never to this raw-JS twin, so every static SEO page (the dominant
 * traffic surface) sent unfiltered exceptions, including confirmed-benign
 * "Script error." noise.
 */
const POSTHOG_BENIGN_SOURCE = BENIGN_MESSAGES.map((re) => re.source).join('|');
const POSTHOG_THIRD_PARTY_STACK_SOURCE = THIRD_PARTY_STACK_ORIGINS.map((re) => re.source).join('|');
/**
 * Stack-SHAPE counterpart of the origin list above (#4173): interpolated
 * from services/benignErrorPatterns.ts so the static-page ES5 filter and the
 * SPA TypeScript filter cannot drift on the frame pattern.
 */
const POSTHOG_ORIGIN_REDACTED_FRAME_SOURCE = WEBKIT_ORIGIN_REDACTED_FRAME.source;

const DEPLOY_BUILD_ID_OVERRIDE = (process.env.DEPLOY_BUILD_ID || '').replace(/\D/g, '');
export const BUILD_ID = DEPLOY_BUILD_ID_OVERRIDE || String(Date.now());
export const BUILD_DATE_STAMP = new Date(Number(BUILD_ID)).toISOString().slice(0, 10);

/**
 * Fail-fast guard for the externalised stylesheets that live in
 * `public/assets/` (Vite copies the public/ tree to dist/ at the start of
 * the build, so the file lands in dist/assets/ under the same name). The
 * read at module-load time keeps the historical invariant that a missing
 * source file fails the build immediately instead of shipping ~822k pages
 * whose `<link>` 404s.
 *
 * The filenames are STABLE (no content hash) like every other bundler
 * asset — see vite.config.ts `chunkFileNames`/`assetFileNames` for the full
 * rationale (the serving stack revalidates at max-age=600, so a content
 * change propagates without a rename, while a rename re-churned ~822k
 * prerendered pages and 404'd from HTML cached under the old name). This
 * invariant is pinned by `tests/stable-asset-names.test.ts`.
 */
export function readPublicAsset(relPath: string): string {
  // Walk up from `build-plugins/constants.ts` to the repo root.
  // process.cwd() is unreliable (depends on how Vite was invoked); the
  // file's own location is the stable anchor.
  // __dirname is not available in ESM — resolve via import.meta.url.
  const here = path.dirname(new URL(import.meta.url).pathname);
  let dir = here;
  while (dir !== '/' && !fs.existsSync(path.join(dir, 'package.json'))) {
    dir = path.dirname(dir);
  }
  return fs.readFileSync(path.join(dir, 'public', 'assets', relPath), 'utf-8');
}

function assertPublicAssetExists(relPath: string): void {
  readPublicAsset(relPath);
}

assertPublicAssetExists('seo-static.css');
assertPublicAssetExists('bridge.css');

export const SEO_STATIC_CSS_FILENAME = 'seo-static.css';
export const SEO_STATIC_CSS_LINK = `<link rel="stylesheet" href="/assets/${SEO_STATIC_CSS_FILENAME}">`;
export const BRIDGE_CSS_FILENAME = 'bridge.css';
export const BRIDGE_CSS_LINK = `<link rel="stylesheet" href="/assets/${BRIDGE_CSS_FILENAME}">`;

/**
 * Cross-origin preconnect to the asset CDN (the frontaliere-cdn Pages site).
 *
 * On deploy builds every render-blocking resource on static + locale-shard
 * pages — index.css, seo-static.css, the SPA bundle, early-boot.js,
 * gtag-init.js — is rebased to `${ASSET_CDN}` (cdn.frontaliereticino.ch) by
 * vite.config.ts `renderBuiltUrl`. Without an early hint the browser only
 * opens that cross-origin socket when it reaches the stylesheet `<link>` ~8.6
 * KB into the `<head>` (after the JSON-LD blocks), paying a full DNS+TCP+TLS
 * round-trip (~50-300 ms) BEFORE the blocking CSS can even start downloading —
 * and static pages carry NO `modulepreload` to the CDN to warm it first.
 * Emitting one `<link rel="preconnect">` as an early head hint overlaps that
 * handshake with head parsing → shaves the round-trip off first paint on every
 * page in every locale.
 *
 * `crossorigin` makes it an anonymous (uncredentialed) connection — the same
 * mode the CDN stylesheet/script/font fetches use — so the warmed socket is
 * reused for all of them (HTTP/2 coalesces the no-cors seo-static.css onto the
 * same uncredentialed connection). A single hint therefore covers every CDN
 * fetch; no `dns-prefetch` fallback is emitted (preconnect already resolves
 * DNS, and the ~57 extra bytes ride on ~822k pages).
 *
 * Built from process.env.ASSET_CDN (deploy builds only — the same env that
 * drives renderBuiltUrl). Empty string on dev / non-CDN builds, where assets
 * stay same-origin and no preconnect is needed. constants.ts is build-only
 * (it already imports child_process/node:fs), so reading process.env here is
 * safe — no client bundle pulls it in.
 */
const ASSET_CDN_ORIGIN = ((): string => {
  const raw = (process.env.ASSET_CDN || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
})();
export const CDN_PRECONNECT_HINT = ASSET_CDN_ORIGIN
  ? `<link rel="preconnect" href="${ASSET_CDN_ORIGIN}" crossorigin>`
  : '';

/**
 * Generate a lightweight canonical bridge page for alias URLs.
 * These pages avoid GitHub Pages redirect quirks while keeping the canonical target explicit
 * without shipping a hard noindex/meta-refresh combination that can accumulate in Search Console.
 */
/**
 * Inline <script> added to every static bridge/archive page.
 * If the URL carries SPA-relevant query params (newsletter confirmation,
 * auth tokens, unsubscribe, etc.), save the full URL in sessionStorage and
 * redirect to / so the React app can process the action.
 *
 * IMPORTANT: tracking + autologin params (`ne`, `ac`) are intentionally NOT
 * in the trigger set. They appear on EVERY newsletter content link (article,
 * job detail, company hub) and are processed in-place by `App.tsx` after
 * hydration — App.tsx exchanges `ac` for a fresh auth token and strips both
 * params from the URL via `history.replaceState`. Triggering a redirect on
 * `ne`/`ac` destroys the static document the user just landed on (and any
 * window-seeded data like `__EXPIRED_JOB_DATA__` / `__BRIDGE_TARGET_SLUG__`)
 * because `location.replace('/')` loads a fresh `index.html` that no longer
 * has those globals — soft-landing pages then fall back to the generic
 * "annuncio non trovato" view instead of the rich expired-job content.
 */
/**
 * Plain JS body (no <script> wrapper) — written to dist/assets/spa-action-redirect.js
 * by staticScriptsPlugin and referenced via <script src="..."> from SPA_ACTION_REDIRECT_SCRIPT.
 * Externalising this snippet saves ~150 B/page across ~200k SEO pages (~30 MB dist).
 */
export const SPA_ACTION_REDIRECT_SCRIPT_CONTENT = `(function(){var p=new URLSearchParams(location.search);if(p.get('action')||p.get('at')||p.get('authToken')||p.get('newsletter_autologin')){sessionStorage.redirect=location.href;location.replace('/');}})();`;

/**
 * Plain JS body for the dark-mode init — written to dist/assets/dark-mode-init.js
 * by staticScriptsPlugin. Adds 'dark' class to <html> before first paint to avoid
 * FOUC on dark-mode pages. Used by soft-landing + staticPagesPlugin templates.
 * Externalising drops ~140 B/page across the ~100k pages that emit it (~14 MB dist).
 *
 * Loaded synchronously (no defer/async) — must run before paint so dark-mode
 * styles in seo-static.css apply on first render.
 */
export const DARK_MODE_INIT_CONTENT = `(function(){if(localStorage.theme==='dark'||((!('theme' in localStorage))&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark')}})();`;

/**
 * Plain JS body for cross-chunk version-skew self-heal — written to
 * dist/assets/early-boot.js (via EARLY_BOOT_CONTENT below) by staticScriptsPlugin.
 *
 * Previously this recovery logic existed ONLY as an inline <script> in the root
 * index.html, registered before the deferred SPA module script so it could catch
 * link-time errors that fire before React ever mounts. Every OTHER static page
 * (job-detail, soft-landing, hub, landing, etc. — generated by jobsSeoPagesPlugin
 * / staticPagesPlugin / seoPageShell) already loads early-boot.js via
 * EARLY_BOOT_SCRIPT (aliased as SPA_ACTION_REDIRECT_SCRIPT / DARK_MODE_SCRIPT)
 * before their own module entry script, but that file only ever contained
 * dark-mode-init + spa-action-redirect — so a cold deep-link (e.g. a job-alert
 * email click) hitting a version-skewed chunk on one of those pages had NOTHING
 * listening for it: the SyntaxError killed module instantiation before React (and
 * therefore ErrorBoundary) ever existed, permanently stranding the user on the
 * static shell. Concatenating this content here fixes every such page at once.
 *
 * Mirrors the recovery in resilientImport.ts (isVersionSkewError /
 * isModuleLinkSkewMessage / isChunkLoadError) and the historical inline
 * index.html script. The message regexes are no longer hand-copied: this
 * file (build-plugins/constants.ts, which runs under Node/Vite at BUILD
 * TIME) imports resilientImport.ts's exported pattern arrays
 * (CALL_TIME_SKEW_PATTERNS / MODULE_LINK_SKEW_PATTERNS /
 * CHUNK_LOAD_ERROR_SUBSTRINGS) and inlines their `.source`/escaped text into
 * the raw script below via template interpolation — see
 * CALL_TIME_SKEW_SOURCE / MODULE_LINK_SKEW_SOURCE / CHUNK_LOAD_ERROR_SOURCE
 * above. Only the EMITTED early-boot.js (this string's runtime output)
 * cannot `import` resilientImport.ts — it runs before any module JS loads —
 * so the patterns are baked in as literal regex text at build time instead
 * of drifting as a second hand-maintained copy (issue #3216 item 1;
 * AGENTS.md §Non-Negotiables #6).
 *
 * `_swReloadCount` (sessionStorage) is the SAME reload-budget key used by
 * resilientImport.ts and index.html, so all recovery surfaces share one budget
 * per browser session, regardless of which page/shell fires it. Stored as a
 * JSON map `{ [signature]: attempts }` (via `fcb`, mirroring
 * consumeReloadBudget in resilientImport.ts) rather than a flat counter, so
 * each DISTINCT stale chunk/message gets its own MAX_RELOADS(=2) attempts —
 * capped overall by MAX_TOTAL_RELOADS(=6) — instead of one shared session-wide
 * slot that a single earlier, unrelated skew event could permanently exhaust.
 *
 * Issue #3149 hardening (mirrored across all three copies, keep in sync):
 * (1) raises the Resource Timing buffer cap to 1000 as the very first
 *     statement in the IIFE — this script runs before the module entry
 *     script on every static page, so the raise lands before the bulk of
 *     page resources load, preventing the buffer (spec-floor default 250)
 *     from silently evicting a version-skewed chunk's timing entry over a
 *     long-lived SPA session; (2) the DOM-scan enumeration fallback in
 *     `bust()` now always unions with Resource Timing results instead of
 *     only running when it comes back empty (still cannot recover chunks
 *     loaded via dynamic import(), which never leave a DOM node — the
 *     buffer raise is the mitigation for those); (3) the refetch uses
 *     `credentials:'same-origin'` (not the old `'omit'`) to match the
 *     spec-default credentials mode of a `<script type="module">` with no
 *     `crossorigin` attribute in both deploy shapes (CDN cross-origin and
 *     same-origin fallback when `ASSET_CDN` is unset).
 */
export const SELF_HEAL_SCRIPT_CONTENT = String.raw`(function(){try{if(window.performance&&typeof performance.setResourceTimingBufferSize==='function'){performance.setResourceTimingBufferSize(1000);}}catch(e){}var FR_MAX_RELOADS=2;var FR_MAX_TOTAL_RELOADS=6;function fcb(sig){var b={};try{var p=JSON.parse(sessionStorage.getItem('_swReloadCount')||'{}');if(p&&typeof p==='object'&&!Array.isArray(p))b=p;}catch(e){}var k=String(sig||'unknown').slice(0,150);var t=0;for(var x in b)if(Object.prototype.hasOwnProperty.call(b,x))t+=b[x];var c=b[k]||0;if(c>=FR_MAX_RELOADS||t>=FR_MAX_TOTAL_RELOADS)return false;b[k]=c+1;try{sessionStorage.setItem('_swReloadCount',JSON.stringify(b));}catch(e){}return true;}if('serviceWorker' in navigator){navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){r.unregister();});});}function bust(){function rl(){try{location.reload();}catch(e){}}function cc(){if(!('caches' in window))return Promise.resolve();return caches.keys().then(function(ns){return Promise.all(ns.map(function(n){return caches.delete(n);}));}).catch(function(){});}var urls=[];try{var es=(window.performance&&performance.getEntriesByType)?performance.getEntriesByType('resource'):[];for(var i=0;i<es.length;i++){var n=es[i].name||'';if(/\/assets\/.+\.(js|css)(\?|$)/.test(n))urls.push(n);}}catch(e){}try{var els=document.querySelectorAll('script[src*="/assets/"], link[href*="/assets/"]');for(var j=0;j<els.length;j++){var u=els[j].src||els[j].href;if(u)urls.push(u);}}catch(e){}var uq=[];for(var k=0;k<urls.length;k++)if(uq.indexOf(urls[k])===-1)uq.push(urls[k]);if(!uq.length||typeof fetch!=='function'){cc().then(rl,rl);return;}var done=false;function fin(){if(done)return;done=true;rl();}setTimeout(fin,4000);cc().then(function(){return Promise.all(uq.map(function(u){return fetch(u,{cache:'reload',mode:'cors',credentials:'same-origin'}).catch(function(){});}));}).then(fin,fin);}window.addEventListener('unhandledrejection',function(e){var r=e.reason;var m=r instanceof Error?r.message:String(r||'');if(m.indexOf('IDBDatabase')!==-1||m.indexOf('IndexedDB')!==-1||m.indexOf('Indexed Database')!==-1){e.preventDefault();}});window.addEventListener('error',function(e){if(e.target&&(e.target.tagName==='SCRIPT'||e.target.tagName==='LINK')){var src=e.target.src||e.target.href||'';var tt=e.target.tagName==='SCRIPT'?'script':'link';var isAsset=src.indexOf('/assets/')!==-1;var adB=/${AD_BLOCKER_SOURCE}/i.test(src);try{var errs=JSON.parse(sessionStorage.getItem('_resourceErrors')||'[]');errs.push({type:tt,url:src.slice(0,300),pagePath:location.pathname+location.search,adBlocked:adB,triggeredReload:false,ts:new Date().toISOString()});if(errs.length>20)errs=errs.slice(-20);sessionStorage.setItem('_resourceErrors',JSON.stringify(errs));}catch(ex){}if(!isAsset)return;if(adB)return;if(!fcb(src)){try{var bl=JSON.parse(sessionStorage.getItem('_resourceErrors')||'[]');if(bl.length>0)bl[bl.length-1].triggeredReload='blocked';sessionStorage.setItem('_resourceErrors',JSON.stringify(bl));}catch(ex){}return;}try{var e2=JSON.parse(sessionStorage.getItem('_resourceErrors')||'[]');if(e2.length>0)e2[e2.length-1].triggeredReload=true;sessionStorage.setItem('_resourceErrors',JSON.stringify(e2));}catch(ex){}try{sessionStorage.setItem('_forceReloadInfo',JSON.stringify({source:'index_html_script',reason:'stale_chunk_'+tt,resource:src.slice(0,300),pagePath:location.pathname+location.search,timestamp:new Date().toISOString()}));}catch(ex){}try{sessionStorage.setItem('_swErrorInfo',JSON.stringify({resource:src,pagePath:location.pathname+location.search,timestamp:new Date().toISOString()}));}catch(ex){}bust();}},true);window.addEventListener('error',function(e){if(e.target&&e.target!==window&&e.target.tagName)return;if(location.hostname==='localhost'||location.hostname==='127.0.0.1')return;var err=e.error;var nm=(err&&err.name)||'';var m=(err&&err.message)||e.message||'';var sc=nm==='TypeError'&&/${CALL_TIME_SKEW_SOURCE}/i.test(m);var sl=/${MODULE_LINK_SKEW_SOURCE}/.test(m);if(!sc&&!sl)return;if(!fcb(m))return;try{sessionStorage.setItem('_forceReloadInfo',JSON.stringify({source:'index_html_skew',reason:'version_skew_typeerror',resource:m.slice(0,300),pagePath:location.pathname+location.search,timestamp:new Date().toISOString()}));}catch(ex){}bust();});window.addEventListener('unhandledrejection',function(e){if(location.hostname==='localhost'||location.hostname==='127.0.0.1')return;var reason=(e.reason&&e.reason.message)||String(e.reason||'');if(!/${CHUNK_LOAD_ERROR_SOURCE}/.test(reason)&&!/${MODULE_LINK_SKEW_SOURCE}/.test(reason))return;var adB=/${AD_BLOCKER_SOURCE}/i.test(reason);try{var errs=JSON.parse(sessionStorage.getItem('_resourceErrors')||'[]');errs.push({type:'dynamic_import',url:reason.slice(0,300),pagePath:location.pathname+location.search,adBlocked:adB,triggeredReload:false,ts:new Date().toISOString()});if(errs.length>20)errs=errs.slice(-20);sessionStorage.setItem('_resourceErrors',JSON.stringify(errs));}catch(ex){}if(adB)return;if(!fcb(reason)){try{var bl=JSON.parse(sessionStorage.getItem('_resourceErrors')||'[]');if(bl.length>0)bl[bl.length-1].triggeredReload='blocked';sessionStorage.setItem('_resourceErrors',JSON.stringify(bl));}catch(ex){}return;}try{var e2=JSON.parse(sessionStorage.getItem('_resourceErrors')||'[]');if(e2.length>0)e2[e2.length-1].triggeredReload=true;sessionStorage.setItem('_resourceErrors',JSON.stringify(e2));}catch(ex){}try{sessionStorage.setItem('_forceReloadInfo',JSON.stringify({source:'index_html_import',reason:'dynamic_import_failure',resource:reason.slice(0,300),pagePath:location.pathname+location.search,timestamp:new Date().toISOString()}));}catch(ex){}try{sessionStorage.setItem('_swErrorInfo',JSON.stringify({resource:reason.slice(0,300),pagePath:location.pathname+location.search,timestamp:new Date().toISOString(),type:'dynamic_import'}));}catch(ex){}bust();});})();`;

/**
 * Combined early-boot script — concatenates dark-mode-init (which MUST run
 * before paint to apply the `dark` class), spa-action-redirect (which is
 * cheap to run synchronously), and the version-skew self-heal handlers (must
 * register before any module JS loads). Replaces THREE separate `<script src>`
 * tags per static page with ONE tag pointing at `/assets/early-boot.js`.
 *
 * Order of concatenation matters: dark-mode FIRST (must paint with the
 * correct theme), then spa-action-redirect (sets sessionStorage and may
 * `location.replace('/')` away — running it after dark-mode keeps the
 * theme decision committed for the next page), then self-heal last (only
 * registers event listeners, so order relative to the other two is safe).
 */
export const EARLY_BOOT_CONTENT = `${DARK_MODE_INIT_CONTENT}${SPA_ACTION_REDIRECT_SCRIPT_CONTENT}${SELF_HEAL_SCRIPT_CONTENT}`;
export const EARLY_BOOT_FILENAME = 'early-boot.js';
export const EARLY_BOOT_SCRIPT = `<script src="/assets/${EARLY_BOOT_FILENAME}"></script>`;

/**
 * Range-selector wiring for the fuel history chart, shared by every page under
 * /prezzi-benzina/ + /prezzi-diesel/ (4 locales × 2 fuels). Previously a ~600 B
 * inline IIFE repeated on every chart page; externalising it to one cached
 * `/assets/fuel-chart.js` strips that per-page weight across the whole fuel
 * corpus and lets the browser cache it once.
 *
 * Self-wires ALL `[data-fuel-history-chart]` blocks on the page (no
 * `currentScript.previousElementSibling` dependency), guarded by a global flag
 * so a duplicate tag (a page with >1 chart) is a no-op. Button visuals follow
 * the `aria-pressed` attribute via seo-static.css; content/stats visibility is
 * toggled with the `.s-on` class.
 */
export const FUEL_CHART_SCRIPT_CONTENT = `(function(){if(window.__fuelChartWired)return;window.__fuelChartWired=1;function wire(root){var btns=root.querySelectorAll('[data-range-btn]');var contents=root.querySelectorAll('[data-range-content]');var statsEls=root.querySelectorAll('[data-range-stats]');function setActive(r){btns.forEach(function(b){b.setAttribute('aria-pressed',b.getAttribute('data-range-btn')===r?'true':'false');});contents.forEach(function(c){c.classList.toggle('s-on',c.getAttribute('data-range-content')===r);});statsEls.forEach(function(s){s.classList.toggle('s-on',s.getAttribute('data-range-stats')===r);});}btns.forEach(function(b){b.addEventListener('click',function(){setActive(b.getAttribute('data-range-btn'));});});}document.querySelectorAll('[data-fuel-history-chart]').forEach(wire);})();`;
export const FUEL_CHART_SCRIPT_FILENAME = 'fuel-chart.js';
export const FUEL_CHART_SCRIPT_TAG = `<script src="/assets/${FUEL_CHART_SCRIPT_FILENAME}" defer></script>`;

/**
 * Back-compat shims for callers that still reference the legacy split-script
 * constants by name (e.g., constants.ts itself in the canonical-bridge / flat
 * redirect helpers). These now point at the merged EARLY_BOOT_SCRIPT — the
 * spa-action-redirect behaviour is included, dark-mode is harmless on bridge
 * pages, and the browser-cached early-boot.js is shared across all surfaces.
 */
export const SPA_ACTION_REDIRECT_SCRIPT = EARLY_BOOT_SCRIPT;
export const DARK_MODE_SCRIPT = EARLY_BOOT_SCRIPT;

export function buildCanonicalBridgePage(options: {
 canonicalUrl: string;
 pathLabel: string;
 title?: string;
 description?: string;
 body?: string;
 ctaLabel?: string;
 lang?: string;
 noindex?: boolean;
 hreflangEntries?: Array<{ hreflang: string; href: string }>;
}): string {
 const {
 canonicalUrl,
 pathLabel,
 title = 'Pagina aggiornata | Frontaliere Ticino',
 description = 'Questa URL ha una versione canonica aggiornata su Frontaliere Ticino.',
 body = 'Questa URL ha una versione aggiornata. Apri la pagina canonica per consultare il contenuto corretto.',
 ctaLabel = 'Apri la pagina corretta',
 lang = 'it',
 noindex = false,
 hreflangEntries,
 } = options;

 // Indexable bridges are real SERP entry points, so they get the same
 // preview qualifiers as any other indexable page (see normalizeRobotsDirective).
 const robotsContent = noindex ? 'noindex,follow' : ROBOTS_INDEX_ENHANCED_CONTENT;
 const hreflangHtml = hreflangEntries && hreflangEntries.length > 0
 ? '\n' + hreflangEntries.map(e => ` <link rel="alternate" hreflang="${e.hreflang}" href="${e.href}">`).join('\n')
 : '';

 return `<!DOCTYPE html>
<html lang="${lang}">
 <head>${REDIRECT_STUB_MARKER}
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width, initial-scale=1">
 <title>${title}</title>
 <meta name="description" content="${clampMetaDescription(description)}">
 <meta name="robots" content="${robotsContent}">
 <link rel="canonical" href="${canonicalUrl}">${hreflangHtml}
 ${ANALYTICS_SNIPPET}
 ${SPA_ACTION_REDIRECT_SCRIPT}
 ${BRIDGE_CSS_LINK}
 </head>
 <body>
 <main class="card">
 <div class="logo">
 <img src="/assets/logo.svg" width="28" height="28" alt="" loading="eager" decoding="async">
 <span>Frontaliere Ticino</span>
 </div>
 <h1>${title}</h1>
 <p>${body}</p>
 <a href="${pathLabel}" class="btn">${ctaLabel}</a>
 </main>
 <div class="footer">&copy; 2026 Frontaliere Ticino</div>
 </body>
</html>`;
}

export interface FlatRedirectOgMeta {
 title: string;
 description: string;
 image: string;
 lang?: string;
}

export function buildFlatRedirect(
 canonicalUrl: string,
 trailingSlashPath: string,
 og?: FlatRedirectOgMeta,
): string {
 const esc = (s: string) =>
 s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
 const lang = og?.lang ?? 'it';
 const title = og ? `${esc(og.title)} | Frontaliere Ticino` : 'Versione canonica disponibile | Frontaliere Ticino';
 // Clamp before escaping: truncating after esc() could amputate an HTML entity
 // (e.g. "&am…"). The SERP budget applies to both the <meta description> and the
 // og:description below. This bridge is always noindex, but clamping keeps the
 // emit path consistent with every other generator (the deferred #2230 sibling).
 const desc = og ? esc(clampMetaDescription(og.description)) : 'Apri la versione canonica aggiornata di questa pagina su Frontaliere Ticino.';
 const ogTags = og
 ? `
 <meta property="og:type" content="article">
 <meta property="og:url" content="${canonicalUrl}">
 <meta property="og:title" content="${esc(og.title)}">
 <meta property="og:description" content="${desc}">
 <meta property="og:image" content="${esc(og.image)}">
 <meta property="og:image:alt" content="${esc(og.title)}">
 <meta property="og:site_name" content="Frontaliere Ticino">
 <meta property="fb:app_id" content="891036063797338">`
 : '';
 return `<!DOCTYPE html>
<html lang="${lang}">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width, initial-scale=1">
 <title>${title}</title>
 <meta name="description" content="${desc}">
 <meta name="robots" content="noindex,follow">
 <link rel="canonical" href="${canonicalUrl}">${ogTags}
 ${ANALYTICS_SNIPPET}
 ${BRIDGE_CSS_LINK}
 </head>
 <body>
 <main class="card">
 <div class="logo">
 <img src="/assets/logo.svg" width="28" height="28" alt="" loading="eager" decoding="async">
 <span>Frontaliere Ticino</span>
 </div>
 <h1>Versione canonica disponibile</h1>
 <p>Questa e una versione alias dell URL. Per contenuto e metadata aggiornati usa la versione canonica con slash finale.</p>
 <a href="${trailingSlashPath}" class="btn">Apri la versione canonica</a>
 </main>
 <div class="footer">&copy; 2026 Frontaliere Ticino</div>
 </body>
</html>`;
}

let _commitHash = 'unknown';
try {
 _commitHash = execSync('git rev-parse HEAD').toString().trim();
} catch { /* CI or shallow clone — safe to ignore */ }

export const COMMIT_HASH = _commitHash;
export const SHORT_COMMIT_HASH = COMMIT_HASH.slice(0, 8);

export const BASE_URL = 'https://frontaliereticino.ch';

/**
 * GA4 measurement ID — same as Firebase Analytics measurementId.
 * Used in the lightweight gtag.js snippet injected into static HTML pages
 * so that page views are tracked even for users who bounce before React hydrates.
 */
export const GA4_MEASUREMENT_ID = 'G-LGJ9LE360F';

/**
 * Lightweight gtag.js snippet for static HTML pages.
 *
 * WHY: Users who bounce before React hydrates and Firebase Analytics
 * initializes would have no page_view at all. This inline snippet fires
 * a page_view immediately on load, capturing those sessions.
 *
 * PERFORMANCE: gtag.js is loaded with `async` and the config uses
 * `transport_type: 'beacon'` so it doesn't block page rendering or
 * interfere with SPA hydration.
 *
 * NOTE: We no longer set `window.__GTAG_PAGE_VIEW_SENT__` here.
 * Previously the flag was used by analytics.ts to skip the Firebase
 * page_view and avoid a duplicate. But the flag was set synchronously
 * before gtag.js loaded, so when gtag.js was blocked (ad blockers,
 * ~30-40% of users), Firebase also skipped → sessions had no page_view
 * → GA4 landing page = "(not set)" for ~25% of sessions.
 * Firebase now always fires page_view, accepting a minor duplicate for
 * non-blocked users in exchange for correct landing page in all sessions.
 */
/**
 * Plain JS body for the gtag init — written to dist/assets/gtag-init.js by
 * staticScriptsPlugin. The googletagmanager loader stays inline (it's already
 * external + async). Saves ~260 B/page across ~200k SEO pages (~52 MB dist).
 */
export const GTAG_INIT_CONTENT = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${GA4_MEASUREMENT_ID}',{transport_type:'beacon'});`;
export const GTAG_INIT_FILENAME = 'gtag-init.js';
// gtag-init.js only pushes the GA4 page_view onto window.dataLayer; it does
// NOT need to run before paint. `defer` takes it off the render-blocking path
// (it ran synchronously in <head> before) so first paint no longer waits on a
// cross-origin script fetch — the deferred order still runs it before the
// async gtag/js library consumes the queue. The library tag stays `async`.
/**
 * Cloudflare Web Analytics (RUM/CWV field data) — MANUAL snippet: the
 * zone-level auto-inject never provisions its injection ruleset on this zone
 * (apex HTML flows through the locale-router Worker), so every emitted page
 * ships the beacon directly. Appended to GTAG_SNIPPET so all static emitters
 * get it by construction; index.html carries its own copy for the SPA.
 * The token is public by design (it is meant to appear in served HTML).
 * The `version` key is REQUIRED: without it beacon.min.js posts to the
 * decommissioned central ingest (cloudflareinsights.com → HTML 404); with it
 * the beacon posts same-origin /cdn-cgi/rum (zone ingest — excluded from the
 * trailing-slash-301 rule, which was silently 301-killing beacon POSTs). #3503
 */
export const CF_BEACON_SNIPPET = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "1268b58e83f74d22a2136ff48e0746b7", "version": "2024.6.1"}'></script>`;

export const GTAG_SNIPPET = `<script async crossorigin="anonymous" src="https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}"></script>
 <script defer src="/assets/${GTAG_INIT_FILENAME}"></script>
 ${CF_BEACON_SNIPPET}`;

/**
 * PostHog EU Cloud init snippet for standalone static pages that don't load the
 * SPA bundle (self-healing bridges, flat redirects, salary-hub landing pages,
 * legacy "pagina spostata" pages). Mirrors the config used by services/posthog.ts
 * but with `capture_pageview: true` so pageviews fire without React.
 *
 * The snippet guards against double-init via `e.__SV`, so it's safe to include
 * on pages that may later hydrate with the SPA bundle — the React import path
 * (services/posthog.ts) detects the existing `window.posthog` instance.
 *
 * Keys mirror services/posthog.ts — keep in sync if the key ever rotates.
 */
export const POSTHOG_KEY = 'phc_u8jsgXxFQNB6WcQt9JBcdj9tJrR4NsMws3nQoKdigjbT';
export const POSTHOG_HOST = 'https://t.frontaliereticino.ch';

/**
 * Client-side bot-detection literals shared by every static inline script.
 *
 * `BOT_PATTERNS_LITERAL` serialises services/botPatterns.ts `BOT_UA_PATTERNS`.
 * `BOT_GATE_FN` is the inline-JS twin of services/botPatterns.ts `isLikelyBot()`
 * — a function-expression string returning `true` for bot sessions. It is the
 * SINGLE source for the bot gate in BOTH static inline scripts below
 * (`ADSENSE_LOADER_CONTENT` + `POSTHOG_INIT_CONTENT`), so the logic is never
 * copy-pasted. Behaviour is kept aligned with the TS `isLikelyBot()` by
 * tests/bot-gate-parity.test.ts (same UA matrix, identical verdicts).
 *
 * Why a string and not the TS function: these run inside externalised plain-JS
 * assets emitted at build time (no module graph), so the detection must be
 * embedded literally. botPatterns.ts stays the source of truth for the pattern
 * list; only the wrapper logic is necessarily re-expressed here.
 */
const BOT_PATTERNS_LITERAL = JSON.stringify(BOT_UA_PATTERNS);
export const BOT_GATE_FN = `function(){var ua=(navigator.userAgent||'').toLowerCase();if(!ua||navigator.webdriver===true)return true;var P=${BOT_PATTERNS_LITERAL};for(var k=0;k<P.length;k++)if(ua.indexOf(P[k])>=0)return true;if(ua.indexOf('chrome')>=0&&!('chrome' in window))return true;if(ua.indexOf('chrome')>=0&&ua.indexOf('mobile')<0){var L=navigator.languages;if(L&&L.length===0)return true;if(navigator.plugins&&navigator.plugins.length===0)return true;if(typeof navigator.permissions==='undefined')return true;}return false;}`;

/**
 * Plain JS body for the PostHog snippet — written to dist/assets/posthog-init.js
 * by staticScriptsPlugin. The previous inline version was 1.2 KB embedded in every
 * static page using ANALYTICS_SNIPPET (~14k bridges + ~600 static-pages = ~17 MB).
 * After externalising, per-page cost drops from ~1.2 KB → ~80 B (the <script src> tag).
 *
 * BOT GATE: the entire stub-install + `posthog.init` runs only when `BOT_GATE_FN`
 * reports a real user. On static pages this snippet sets `capture_pageview:true`,
 * so without the gate every bot hit on a bridge/landing page fired a $pageview —
 * a large slice of the free-tier 1M/mo event budget at zero analytics value.
 * Mirrors the SPA gate in services/posthog.ts `ensurePostHog()`.
 *
 * `before_send` (issue #3406/#3407 fix, see POSTHOG_BENIGN_SOURCE comment
 * above): re-implements `createExceptionFilter()` from
 * services/posthog-error-filter.ts in plain ES5 — extracts
 * `$exception_values`/`$exception_list` message text and drops the event on
 * a BENIGN_MESSAGES match, then falls back to a resolved-stack-frame check
 * that drops exceptions whose ENTIRE stack lives in a known third-party
 * script origin (THIRD_PARTY_STACK_ORIGINS). Wrapped in try/catch to fail
 * OPEN — a filter bug must never break PostHog init or hide a real error.
 */
const POSTHOG_BEFORE_SEND_FN = `function(ev){try{if(!ev||ev.event!=='$exception')return ev||null;var p=ev.properties||{};var rv=p.$exception_values||p.$exception_list;var msgs=[];if(Array.isArray(rv)){for(var i=0;i<rv.length;i++){var v=rv[i];if(typeof v==='string')msgs.push(v);else if(v&&typeof v==='object'&&typeof v.value==='string')msgs.push(v.value);}}var blob=msgs.join(' | ');if(blob&&/${POSTHOG_BENIGN_SOURCE}/i.test(blob))return null;var list=p.$exception_list;var origins=[];if(Array.isArray(list)){for(var j=0;j<list.length;j++){var exc=list[j];var frames=exc&&exc.stacktrace&&exc.stacktrace.frames;if(Array.isArray(frames)){for(var k=0;k<frames.length;k++){var fr=frames[k];var fn=fr&&(fr.filename||(fr.junk_drawer&&fr.junk_drawer.raw_frame&&fr.junk_drawer.raw_frame.filename));if(fn)origins.push(fn);}}}}if(origins.length>0){var allTP=true;for(var m=0;m<origins.length;m++){if(!/${POSTHOG_THIRD_PARTY_STACK_SOURCE}/i.test(origins[m])){allTP=false;break;}}if(allTP)return null;}if(origins.length===0){var key=String(blob||'').replace(/^(?:Uncaught\\s+)?(?:\\w*Error:\\s*)?/,'').replace(/^\\s+|\\s+$/g,'').slice(0,120);var buf=window.__frRawStacks||[];var raw='';for(var q=buf.length-1;q>=0;q--){var ek=String(buf[q][0]||'').replace(/^(?:Uncaught\\s+)?(?:\\w*Error:\\s*)?/,'').replace(/^\\s+|\\s+$/g,'').slice(0,120);if(key&&ek&&(key.indexOf(ek)>=0||ek.indexOf(key)>=0)){raw=buf[q][1];break;}}if(raw){var fr=raw.split('\\n'),cl=[];for(var z=0;z<fr.length;z++){var tl=fr[z].replace(/^\\s+|\\s+$/g,'');if(tl)cl.push(tl);}if(cl.length>=${ORIGIN_REDACTED_MIN_FRAMES}){var allRed=true;for(var y=0;y<cl.length;y++){if(!/${POSTHOG_ORIGIN_REDACTED_FRAME_SOURCE}/.test(cl[y])){allRed=false;break;}}if(allRed)return null;}}}return ev;}catch(e){return ev||null;}}`;
export const POSTHOG_INIT_CONTENT = `if(!(${BOT_GATE_FN})()){window.__frRawStacks=window.__frRawStacks||[];function __frRec(m,st){if(!st)return;window.__frRawStacks.push([String(m||''),String(st)]);if(window.__frRawStacks.length>8)window.__frRawStacks.shift();}window.addEventListener('error',function(e){var er=e&&e.error;if(er&&er.stack)__frRec(er.message||e.message,er.stack);});window.addEventListener('unhandledrejection',function(e){var r=e&&e.reason;if(r&&r.stack)__frRec(r.message,r.stack);});!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags identify setPersonProperties group resetGroups reset opt_in_capturing opt_out_capturing".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);posthog.init('${POSTHOG_KEY}',{api_host:'${POSTHOG_HOST}',capture_pageview:true,capture_pageleave:true,autocapture:false,persistence:'localStorage',before_send:${POSTHOG_BEFORE_SEND_FN}});}`;
export const POSTHOG_INIT_FILENAME = 'posthog-init.js';
export const POSTHOG_SNIPPET = `<script src="/assets/${POSTHOG_INIT_FILENAME}"></script>`;

/**
 * Google AdSense loader snippet. Included in every statically-generated page
 * (job detail, hubs, fuel, health premiums, orphan queries, etc.) so Auto Ads
 * can serve on pages that do not mount the <AdSenseBanner> React component.
 * The client ID must match the meta `google-adsense-account` in index.html.
 *
 * LAZY LOADING (2026-04-23): adsbygoogle.js is no longer eagerly injected in
 * <head>. Semrush flagged 8129 "uncompressed JS" notices because every static
 * crawl fetched the script synchronously. Instead we ship:
 *  - preconnect hints to pagead2 so when we do load it's fast
 *  - google-adsense-account meta (required for AdSense site verification)
 *  - an inline IntersectionObserver loader that injects the script and pushes
 *    each <ins class="adsbygoogle"> slot the first time it scrolls within
 *    200px of the viewport. If no slot ever becomes visible, the script is
 *    never loaded — Semrush/Google crawlers stop seeing it in audits.
 *  - a first-interaction trigger (scroll/touchstart/pointerdown/keydown/
 *    mousemove, once+passive) that loads the script on the first real user
 *    engagement. This closes the biggest Auto Ads leak: quick-bounce mobile
 *    sessions (75% of traffic) that tap/scroll but leave before the idle
 *    fallback fires, so the anchor/vignette overlays never serve. Crawlers
 *    don't interact, so the Semrush "no synchronous JS" benefit is preserved.
 *  - a requestIdleCallback fallback that still loads the script after idle so
 *    Auto Ads (anchor, vignette, in-page) continue to earn on pages with no
 *    manual <ins> slots and no interaction.
 */
export const ADSENSE_CLIENT_ID = 'ca-pub-8628054934855353';
export const ADSENSE_SCRIPT_SRC = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT_ID}`;

/**
 * Inline lazy-loader injected at the bottom of every static page (and also
 * emitted from index.html). Runs once per page and:
 *  0. Bot gate: `BOT_GATE_FN` (shared with POSTHOG_INIT_CONTENT, the inline-JS
 *     twin of services/botPatterns.ts `isLikelyBot()`) returns true for bots —
 *     the loader then returns immediately. This is the static-HTML counterpart
 *     to `<AdSenseBanner>`'s SKIP_FOR_BOT and extends the bot filter to Auto Ads
 *     (Anchor / In-page / Vignette) which are injected by adsbygoogle.js itself,
 *     bypassing the React component. ~95% of revenue comes from those Auto Ads
 *     formats — without this gate, bots still triggered the script load and
 *     inflated AD_REQUESTS at near-zero RPM. See services/botPatterns.ts for the
 *     shared pattern source.
 *  0.5. Reader no-ads entitlement (#3655, part 2/2 of #2961): if
 *     localStorage `reader_noads_active` is `'true'`, the loader also returns
 *     immediately — the static-HTML counterpart to the same check in
 *     <AdSenseBanner> (services/readerEntitlement.ts
 *     `hasActiveReaderNoAdsEntitlement()`). Per-visitor only, set/cleared by
 *     services/readerEntitlement.ts's Firestore listener — NEVER a
 *     global/per-route toggle (AGENTS.md Non-Negotiable #7).
 *  1. Watches every <ins class="adsbygoogle"> with IntersectionObserver
 *     (rootMargin 200px) — on first visible slot, loads adsbygoogle.js.
 *  2. Falls back to requestIdleCallback for pages without manual slots so Auto
 *     Ads still serve. Browsers lacking requestIdleCallback (legacy iOS Safari
 *     < 16.4 — has IntersectionObserver since 12.2 but no rIC until 16.4) use
 *     `ricFb`, which defers the ad fetch past the `load` event (i.e. after LCP)
 *     instead of a flat sub-second setTimeout. A fixed 0.8–1.2s timeout could
 *     fire the script *before* LCP on slow connections, regressing LCP; gating
 *     on `load` bounds that structurally. Engaged users are unaffected — the
 *     first-interaction triggers load the script immediately regardless. The
 *     index.html googlefc loader uses the same `ricFb` load-gating for its
 *     no-rIC path, so both static-shell ad/CMP fetch paths are load-gated (not
 *     timer-gated). AdSenseBanner.tsx keeps a flat 1.5s no-rIC timer because it
 *     runs in a post-hydration effect (already after LCP), so it needs no gate.
 *  3. On script load, pushes {} once for every `<ins>` currently in the DOM.
 *     NOTE: `adsbygoogle.push({})` is NOT bound to a specific slot — each push
 *     fills the next not-yet-statused `<ins>` in DOM order. So the push COUNT
 *     must equal the number of `<ins>` (push-per-ins), never a filtered subset,
 *     or trailing slots (e.g. the end-of-list multiplex) would be left
 *     unprocessed. Off-device/hidden units are avoided upstream by emitting a
 *     single responsive `<ins>` per in-feed point (see `infeedAdListItemHtml`),
 *     not by skipping pushes here.
 */
/**
 * Plain JS body for the AdSense lazy loader — written to dist/assets/adsense-loader.js
 * by staticScriptsPlugin. This was the LARGEST inline script in every static page:
 * ~2 KB minified × ~200k SEO pages = ~400 MB dist. Externalising drops per-page cost
 * from ~2200 B to ~90 B (the <script src=...> tag).
 */
export const ADSENSE_LOADER_CONTENT = `(function(){if((${BOT_GATE_FN})())return;if(window.localStorage.getItem('reader_noads_active')==='true')return;if(!(function(){try{return window.localStorage.getItem('${ADS_CONSENT_STORAGE_KEY}')==='${ADS_CONSENT_GRANTED}';}catch(e){return false;}})())return;var loaded=false;function loadScript(){if(loaded)return;loaded=true;if(document.querySelector('script[src*="pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]'))return;var s=document.createElement('script');s.async=true;s.crossOrigin='anonymous';s.src='${ADSENSE_SCRIPT_SRC}';s.setAttribute('data-overlays','bottom');s.setAttribute('data-ad-frequency-hint','60s');s.onload=function(){var slots=document.querySelectorAll('ins.adsbygoogle:not([data-adsbygoogle-status])');for(var i=0;i<slots.length;i++){try{(window.adsbygoogle=window.adsbygoogle||[]).push({});}catch(e){}}};document.head.appendChild(s);}function ricFb(cb){if(document.readyState==='complete'){setTimeout(cb,200);}else{window.addEventListener('load',function(){setTimeout(cb,200);},{once:true});}}function observe(){var EV=['scroll','touchstart','pointerdown','keydown','mousemove'];for(var e=0;e<EV.length;e++)document.addEventListener(EV[e],loadScript,{once:true,passive:true,capture:true});var slots=document.querySelectorAll('ins.adsbygoogle');if(!('IntersectionObserver' in window)||slots.length===0){(window.requestIdleCallback||ricFb)(loadScript,{timeout:1500});return;}var io=new IntersectionObserver(function(entries){for(var i=0;i<entries.length;i++){if(entries[i].isIntersecting){io.disconnect();loadScript();return;}}},{rootMargin:'200px 0px'});for(var j=0;j<slots.length;j++)io.observe(slots[j]);(window.requestIdleCallback||ricFb)(loadScript,{timeout:2500});}if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',observe,{once:true});}else{observe();}})();`;
export const ADSENSE_LOADER_FILENAME = 'adsense-loader.js';
export const ADSENSE_LAZY_LOADER = `<script defer src="/assets/${ADSENSE_LOADER_FILENAME}"></script>`;

/**
 * Publisher id (no `ca-` prefix) for the Funding Choices endpoints, derived
 * from {@link ADSENSE_CLIENT_ID} so it never drifts from the AdSense account.
 */
export const FC_PUBLISHER_ID = ADSENSE_CLIENT_ID.replace(/^ca-/, ''); // pub-8628054934855353

/**
 * Offerwall custom-choice registry + Funding Choices MESSAGING loader, injected
 * PARSE-TIME into the <head> of in-scope STATIC article pages.
 *
 * WHY THIS EXISTS (2026-06-16): the GAM Offerwall is scoped to the article
 * sections, which are emitted as static SSG HTML (staticPagesPlugin) whose head
 * does NOT carry index.html's inline Offerwall block. On those pages the only
 * Funding Choices loader that ever runs is the network-code one pulled in by
 * adsbygoogle.js AFTER hydration — it fetches the Offerwall /f/ message (200,
 * incl. our custom choice) but never instantiates the overlay. The publisher-id
 * MESSAGING loader (`/i/pub-XXX`) — the one index.html uses on SPA roots and the
 * one that actually renders FC messages — is absent. Injecting the registry +
 * pub-id loader at PARSE TIME (before hydration and before adsbygoogle's
 * network-code loader claims the singleton FC instance) brings article pages to
 * parity with index.html's proven render path. (#2312 injected the same loader
 * POST-hydration via the React gate and it never rendered, because FC was
 * already singleton-initialised by the network-code loader — parse-time is the
 * differentiator.)
 *
 * MUST stay byte-aligned with index.html's loadFc()/registry on the essentials
 * (same pub-id loader URL, `data-fc-loader` dedup marker, NO crossOrigin — see
 * tests/index-html-fc-loader.test.ts for the CORS rationale — googlefcPresent
 * signal, requestIdleCallback/DOMContentLoaded deferral for LCP, and — since
 * #5894 — the same fail-closed advertising-consent read as ADSENSE_LOADER_
 * CONTENT/index.html before the loader `<script>` is appended: only a literal
 * ADS_CONSENT_GRANTED opens it). The drift guard lives in
 * tests/offerwall-static-fc-snippet.test.ts. The registry's behaviour mirrors
 * components/community/OfferwallNewsletterGate.tsx (ensureOfferwallRegistry),
 * which is idempotent (`if (cc.registry) return`) and so no-ops when this
 * parse-time copy already set it — the gate still installs the
 * window.__ftOfferwallSubscribe hook this registry delegates to. The registry
 * itself stays consent-UNGATED (it defines a callback object, makes no network
 * call, and must exist before FC — whenever it eventually loads — can call
 * into it).
 *
 * The anti-adblock fallback IIFE that index.html also runs from loadFc() is
 * deliberately NOT included here — it is a separate feature, out of scope for
 * the Offerwall render fix.
 */
export const OFFERWALL_FC_SNIPPET = `<script>(function(){var g=window.googlefc=window.googlefc||{};var ow=g.offerwall=g.offerwall||{};var cc=ow.customchoice=ow.customchoice||{};if(cc.registry)return;function hasAccess(){try{if(window.localStorage.getItem('newsletter_subscribed')==='true')return true;for(var i=0;i<window.localStorage.length;i++){var k=window.localStorage.key(i);if(k&&k.indexOf('firebase:authUser:')===0)return true;}}catch(e){}return false;}cc.registry={initialize:function(params){var E=cc.InitializeResponseEnum||{};if(hasAccess()){return Promise.resolve(E.ACCESS_GRANTED||'ACCESS_GRANTED');}window.__ftOfferwallLang=(params&&params.offerwallLanguageCode)||null;return Promise.resolve(E.ACCESS_NOT_GRANTED||'ACCESS_NOT_GRANTED');},show:function(){var fn=window.__ftOfferwallSubscribe;function run(f){try{return Promise.resolve(f(window.__ftOfferwallLang)).then(function(ok){return !!ok;});}catch(e){return Promise.resolve(false);}}if(typeof fn!=='function'){return new Promise(function(resolve){var settled=false;function settle(ok){if(settled)return;settled=true;resolve(!!ok);}var q=window.__ftOfferwallShowQueue=window.__ftOfferwallShowQueue||[];var timer=setTimeout(function(){settle(false);},10000);q.push(function(hook){if(settled)return;clearTimeout(timer);run(hook).then(settle,function(){settle(false);});});});}return run(fn);}};})();</script>
 <script>(function(){function loadFc(){if(!document.querySelector('script[data-fc-loader]')){var s=document.createElement('script');s.async=true;s.src='https://fundingchoicesmessages.google.com/i/${FC_PUBLISHER_ID}?ers=1';s.setAttribute('data-fc-loader','1');document.head.appendChild(s);}(function sig(){if(!window.frames['googlefcPresent']){if(document.body){var f=document.createElement('iframe');f.style='width:0;height:0;border:none;z-index:-1000;left:-1000px;top:-1000px;';f.style.display='none';f.name='googlefcPresent';document.body.appendChild(f);}else{setTimeout(sig,0);}}})();}function ricFb(cb){if(document.readyState==='complete'){setTimeout(cb,200);}else{window.addEventListener('load',function(){setTimeout(cb,200);},{once:true});}}function schedule(){(window.requestIdleCallback||ricFb)(loadFc,{timeout:4000});}if(document.readyState==='loading'){window.addEventListener('DOMContentLoaded',schedule,{once:true});}else{schedule();}})();</script>`;

/**
 * Above-the-fold manual slot for drive-by SEO landings (health premiums,
 * fuel daily, border wait) — pages with 7-11s median sessions whose only
 * manual unit was the end-of-page ARTICLE_END_MULTIPLEX, far below the
 * fold (2026-06 revenue deep dive). A slot near the primary data area makes
 * the adsense lazy loader's IntersectionObserver fire at first paint, so
 * adsbygoogle.js loads immediately instead of waiting for the idle
 * fallback. Markup comes from adSlotHtml('FT_DRIVEBY_ATF_DISPLAY') so format
 * and the CLS-reserving min-height stay driven by the services/adsenseSlots
 * registry — never hand-roll the <ins> here (PR #1910 review).
 *
 * The registry's FT_DRIVEBY_ATF_DISPLAY entry currently mirrors the ACTIVE
 * HOMEPAGE_MID_DISPLAY slot id because the AdSense Management API forbids
 * ad-unit creation (403 PERMISSION_DENIED, verified 2026-06-18 even with a
 * full adsense write-scope token — console-only for this account). The owner
 * isolates drive-by reporting from the homepage by creating the dedicated
 * console unit and swapping that one slot id in services/adsenseSlots.ts —
 * this snippet needs no further change (issue #1911 item 1).
 */
export const DRIVEBY_AD_SNIPPET = `<div class="my-6">
    ${adSlotHtml('FT_DRIVEBY_ATF_DISPLAY')}
  </div>`;

export const ADSENSE_SNIPPET = `<meta name="google-adsense-account" content="${ADSENSE_CLIENT_ID}">
 <link rel="preconnect" href="https://pagead2.googlesyndication.com" crossorigin>
 <link rel="dns-prefetch" href="https://pagead2.googlesyndication.com">
 ${ADSENSE_LAZY_LOADER}`;

/** Combined analytics snippet (GA4 + PostHog + AdSense) for static pages without the SPA bundle. */
export const ANALYTICS_SNIPPET = `${GTAG_SNIPPET}
 ${POSTHOG_SNIPPET}
 ${ADSENSE_SNIPPET}`;

/** Favicon link tags shared across all static HTML pages. */
export const FAVICON_LINKS = `<link rel="icon" href="/favicon.ico" sizes="48x48">
 <link rel="icon" type="image/svg+xml" href="/favicon.svg">`;

/**
 * Count words of visible text in an HTML string, stripping all tags.
 * Used to decide whether a static page has enough content to be indexed (>= 50 words).
 */
export function countHtmlBodyWords(html: string): number {
 // Strip HTML tags
 const text = html.replace(/<[^>]+>/g, ' ');
 // Collapse whitespace and split into words
 const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(w => w.length > 0);
 return words.length;
}

/** Minimum word count for a page to be considered indexable (not thin content). */
export const MIN_INDEXABLE_WORDS = 50;

/**
 * Shared below-floor tag -- reused by both content-gated robots helpers below.
 * Exported so callers that already hold a pre-computed word count (avoiding a
 * redundant {@link countHtmlBodyWords} re-scan of the same body -- see
 * jobsSeoPagesPlugin.ts's expired-soft-landing loop) can branch on it directly
 * instead of going through {@link robotsMetaEnhancedForContent}.
 */
export const ROBOTS_NOINDEX_FOLLOW = '\n <meta name="robots" content="noindex,follow">';

/** Matches an emitted robots meta tag whatever its `content` value is. */
const ROBOTS_META_TAG_RE = /<meta\s+name=["']?robots["']?[^>]*>/i;

/**
 * Rewrite (or insert) the robots meta tag of an already-emitted HTML string.
 *
 * Post-emit demotion to `noindex` is how several plugins enforce a policy
 * decision after the page HTML is built (the thin-content floor in
 * `exchangeRatePagesPlugin`, the inert-tail band in
 * `relatedSearchClustersPlugin`). Doing it with a regex that spells out the
 * INDEXABLE content value couples the guard to whatever string the shell
 * happens to emit: the day that directive changes, the guard silently stops
 * matching and pages ship indexable that were meant not to be. Matching the
 * tag by NAME instead of by value is what keeps the guard correct across any
 * future change to the directive.
 *
 * Quote-flexible on the way IN because dist/ HTML is minified upstream
 * (PR #478 `removeAttributeQuotes` turns the tag into
 * `<meta name=robots content=index,follow>`); always quoted on the way OUT.
 *
 * HISTORY: two PRs added this helper to this same file independently (the
 * inert-tail band, and #5170/#5001 centralising `max-image-preview:large`).
 * The note here asked whichever landed second to drop its copy. BOTH landed and
 * NEITHER did, so `main` carried two `const ROBOTS_META_TAG_RE` and two
 * `export function replaceRobotsMeta` — a duplicate-symbol SyntaxError that
 * fails the esbuild transform, i.e. every vitest file importing this module AND
 * the SSG build itself. A note in a comment is not a merge gate; the duplicate
 * is now deleted and tests/build-plugins-no-duplicate-declarations.test.ts
 * makes the next occurrence a failing test instead of a broken main.
 */
export function replaceRobotsMeta(html: string, content: string): string {
 const tag = `<meta name="robots" content="${content}">`;
 return ROBOTS_META_TAG_RE.test(html)
 ? html.replace(ROBOTS_META_TAG_RE, tag)
 : html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${tag}`);
}

/**
 * The `content` value every INDEXABLE page must carry.
 *
 * `max-image-preview:large` is not a nice-to-have: it is the gate Google
 * applies before a page is eligible for a large-image card in Discover and in
 * image-rich SERP treatments. Without it the crawler caps the preview at a
 * thumbnail no matter how good the page's imagery is.
 *
 * This used to exist only as the pre-rendered tag `ROBOTS_INDEX_ENHANCED`,
 * which meant the ~59 page families that pass a `robots` STRING through
 * `buildSimplePage`/`buildSeoPageHtml` had no way to reuse it and all
 * hand-typed the plain `'index,follow'` literal instead. Measured against the
 * live site on 2026-08-05, 50 of 83 sampled sitemap families shipped without
 * `max-image-preview:large` for exactly that reason. Splitting the content
 * string out from the tag is what lets {@link normalizeRobotsDirective} repair
 * all of them at the single emission point.
 *
 * Defined in `./shared/robotsDirective` (Node-import-free) and re-exported
 * here under the same name so existing call sites are unaffected, while
 * client bundle code (e.g. `services/seoService.ts`) can import the shared
 * module directly without pulling in this file's `node:fs`/`child_process`
 * imports.
 */
export { ROBOTS_INDEX_ENHANCED_CONTENT };

/**
 * Upgrade a caller-supplied robots directive to the enhanced indexable form.
 *
 * The contract is deliberately narrow, because this runs on every page the
 * site emits:
 *
 *  - anything that opts OUT of indexing (`noindex`) is returned untouched.
 *    Preview qualifiers are meaningless on a page Google is told not to index,
 *    and rewriting them would risk turning a deliberate exclusion into an
 *    inclusion.
 *  - anything that already carries `max-image-preview` is returned untouched,
 *    so a family that has tuned its own qualifiers keeps them.
 *  - everything else -- in practice the plain `'index,follow'` literal that 88
 *    call sites pass -- is replaced by {@link ROBOTS_INDEX_ENHANCED_CONTENT}.
 *
 * Normalising at the emission point rather than at the 88 call sites is what
 * makes the property hold BY CONSTRUCTION: a new page family that passes
 * `robots: 'index,follow'` (the obvious thing to write, and what every
 * existing family did) is Discover-eligible without its author knowing this
 * rule exists. Editing 88 literals would have fixed today's pages and left the
 * 89th to reintroduce the bug.
 */
export function normalizeRobotsDirective(robots: string): string {
 if (/\bnoindex\b/i.test(robots)) return robots;
 if (/max-image-preview/i.test(robots)) return robots;
 return ROBOTS_INDEX_ENHANCED_CONTENT;
}

/**
 * Returns the appropriate robots meta tag based on the word count of the page body.
 * Pages with >= MIN_INDEXABLE_WORDS get the enhanced indexable directive; below
 * that, `noindex,follow`. Always returns an explicit tag -- never relies on
 * browser defaults.
 *
 * Kept as a distinct name from `robotsMetaEnhancedForContent` only so the
 * existing call sites keep reading naturally; both now emit the same indexable
 * directive. The split used to be meaningful and was the reason expired-job
 * soft landings shipped without `max-image-preview:large`.
 */
export function robotsMetaForContent(bodyHtml: string): string {
 return robotsMetaEnhancedForContent(bodyHtml);
}

/**
 * Enhanced robots directive for indexable pages, asking Google for large
 * snippet/image/video previews in search results. Used by staticPagesPlugin.ts
 * and the raw job templates -- a single shared export so new callers reuse it
 * instead of hand-typing the qualifier list.
 */
export const ROBOTS_INDEX_ENHANCED = `\n <meta name="robots" content="${ROBOTS_INDEX_ENHANCED_CONTENT}">`;

/**
 * Word-count-gated variant of {@link ROBOTS_INDEX_ENHANCED}. For hub-style
 * landing pages (sector/recency hubs) that aren't protected by an upstream
 * inventory floor -- unlike the canton/city editorial hubs, which are always
 * past a floor gate by the time they reach HTML emission and can use
 * `ROBOTS_INDEX_ENHANCED` directly -- so content depth must be checked
 * per-render instead of assumed.
 */
export function robotsMetaEnhancedForContent(bodyHtml: string): string {
 return countHtmlBodyWords(bodyHtml) >= MIN_INDEXABLE_WORDS
 ? ROBOTS_INDEX_ENHANCED
 : ROBOTS_NOINDEX_FOLLOW;
}
