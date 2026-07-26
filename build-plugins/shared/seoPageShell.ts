/**
 * Shared SPA-shell wrapper for SEO feature pages.
 *
 * Why this exists
 * ---------------
 * The 6 SEO feature plugins (fuel-daily, weekly-employers, job-market-snapshot,
 * health-premiums, border-wait, orphan-query) originally emitted HTML that
 * bypassed the site's SPA shell:
 *
 *   <body>
 *     <div id="root"></div>                 <-- EMPTY, React cannot hydrate
 *     <main style="font-family:system-ui">  <-- OUTSIDE #root, bare font
 *       ...content...
 *     </main>
 *   </body>
 *
 * Production curl'ing those URLs revealed: no header nav, no footer, no site
 * theme, system-ui font everywhere. Users landed on orphan-looking pages.
 *
 * This helper wraps the canonical `buildSimplePage()` from htmlTemplate.ts
 * so every SEO feature page renders with:
 *
 *   - `<body class="bg-surface-alt text-heading overflow-x-hidden">` (theme)
 *   - `<script type="module" src="/assets/index-{hash}.js">` (SPA hydration)
 *   - `<link rel="stylesheet" href="/assets/index-{hash}.css">` (site CSS)
 *   - `<div id="root">` containing the SEO content (React hydrates after load)
 *
 * Entry asset resolution
 * ----------------------
 * The entry JS/CSS filenames are STABLE (fixed by vite.config.ts
 * `entryFileNames`/`assetFileNames`, see `./spaEntryFilenames.ts`), so
 * {@link resolveEntryAssets} no longer discovers them by reading and
 * regex-parsing `dist/index.html` — it just confirms the known-fixed
 * filenames exist under `dist/assets/`. This replaced a poll/parse race
 * against `dist/index.html` that was the root cause of repeated deploy
 * failures (#4745 and predecessors) in the sibling `spaBundleResolver.ts`;
 * see that module's header for the full history.
 *
 * {@link resolveEntryAssets} caches the result per-build (keyed by distDir)
 * so each plugin doesn't re-check disk for every page it emits.
 */

import fs from 'node:fs';
import np from 'node:path';
import { buildSimplePage, esc, type SimplePageOpts } from '../htmlTemplate';
import { renderHubChromeSplit, type HubKey, type HubLocale, type HubHero } from './hubChrome';
import { buildTitleWithBrand, TITLE_BRAND_SUFFIX } from './titleSuffix';
import { minifyHtml } from './htmlMinify';
import { SPA_ENTRY_JS_FILENAME, SPA_ENTRY_CSS_FILENAME } from './spaEntryFilenames';

/**
 * Strip any pre-existing " | Frontaliere Ticino" suffix from a callsite-
 * provided title so it can be re-applied uniformly via buildTitleWithBrand
 * (which guarantees the 70-char SERP cap and word-aware headline truncation).
 *
 * Many feature plugins ship copy bundles with the brand baked into the
 * title string. Without this strip+re-apply, those titles bypass the cap
 * and trip audit:title-length on long headlines.
 */
const BRAND_SUFFIX_RX = /\s*\|\s*Frontaliere Ticino\s*$/i;
function normalizeShellTitle(rawTitle: string): string {
  const stripped = String(rawTitle || '').replace(BRAND_SUFFIX_RX, '').trim();
  // htmlTemplate.ts renders this title through `esc(title)` exactly once
  // (single-escape shell) — budget on the ESCAPED length so a raw `&`/`<`/
  // `>`/`"` in a callsite-provided headline (company/city name interpolated
  // upstream, e.g. generateComboPage in jobsSeoPagesPlugin.ts) can't expand
  // past TITLE_MAX_CHARS after this decision is already made. The string
  // itself stays unescaped here — htmlTemplate.ts does the actual escape.
  return buildTitleWithBrand(stripped, TITLE_BRAND_SUFFIX, undefined, (s) => esc(s).length);
}

/** Cached entry-asset resolution, keyed by distDir absolute path. */
interface EntryAssets {
  entryJs: string;
  entryCss: string;
}

const ENTRY_CACHE = new Map<string, EntryAssets>();

/**
 * Resolve the SPA entry JS + CSS bare filenames.
 *
 * These are STABLE, fixed by vite.config.ts (`entryFileNames`/
 * `assetFileNames` — see `./spaEntryFilenames.ts`), so this just confirms
 * the known filenames exist under `dist/assets/` instead of reading and
 * regex-parsing `dist/index.html` (the former approach raced Vite's HTML
 * write — see `spaBundleResolver.ts`'s header for the incident history).
 *
 * Returns empty strings if the assets aren't there (e.g. test environment
 * without a prior Vite build). buildSimplePage tolerates empty entry asset
 * paths by omitting the script/link tags — the page still renders SEO
 * content.
 */
export function resolveEntryAssets(distDir: string): EntryAssets {
  const cached = ENTRY_CACHE.get(distDir);
  if (cached) return cached;

  const assetsDir = np.join(distDir, 'assets');
  const entryJs = fs.existsSync(np.join(assetsDir, SPA_ENTRY_JS_FILENAME)) ? SPA_ENTRY_JS_FILENAME : '';
  const entryCss = fs.existsSync(np.join(assetsDir, SPA_ENTRY_CSS_FILENAME)) ? SPA_ENTRY_CSS_FILENAME : '';

  const out: EntryAssets = { entryJs, entryCss };
  ENTRY_CACHE.set(distDir, out);
  return out;
}

/** Clear the entry-assets cache (used by tests so repeated runs re-resolve). */
export function clearEntryAssetsCache(): void {
  ENTRY_CACHE.clear();
}

export interface SeoPageShellOpts {
  locale: string;
  title: string;
  description: string;
  /** Full canonical URL including `https://` prefix. */
  canonicalUrl: string;
  /** Pre-rendered hreflang `<link>` tags joined by newlines. */
  hreflangHtml?: string;
  /** Inner content HTML — placed inside `<div id="root"><main class="static-job-page">...</main></div>`. */
  bodyHtml: string;
  /** JSON-LD payloads as stringified JSON (one entry per `<script>` tag). */
  jsonLdScripts?: string[];
  /** Per-page og:image override. Defaults to site-wide og-image.png (1200×630). */
  ogImage?: string;
  ogImageWidth?: number;
  ogImageHeight?: number;
  ogImageType?: string;
  ogImageAlt?: string;
  /** Additional `<head>` HTML (extra meta, prev/next links, etc.). MUST NOT contain og:image — use ogImage. */
  extraHeadHtml?: string;
  /** Override OG locale (e.g. `en_US`). Defaults to locale-mapped value. */
  ogLocale?: string;
  /** Robots meta. Defaults to `index,follow`. */
  robots?: string;
  /** OG type. Defaults to `website`. */
  ogType?: string;
  /**
   * Absolute path to the Vite dist directory. Used to resolve the hashed
   * entry JS/CSS. In tests (no prior build) pass undefined and the page
   * will render without hydration tags (but the body class + `<div id="root">`
   * shell are still emitted).
   */
  distDir?: string;
  /**
   * When true, the caller's `bodyHtml` is inserted directly inside
   * `<div id="root">` without the default inner `<main class="static-job-page">`
   * wrap. Use this when `bodyHtml` already contains its own `<main>`
   * element (all 6 SEO feature plugins do).
   *
   * Ignored when {@link seoContentOutsideRoot} is true (the outside-root mode
   * always emits its own `<main class="seo-static-content">` wrapper).
   */
  skipMainWrap?: boolean;
  /**
   * When true (DEFAULT for {@link buildSeoPageHtml}), the SEO content is
   * emitted OUTSIDE `<div id="root">` so React's SPA hydration cannot
   * visually replace it. See SimplePageOpts.seoContentOutsideRoot for the
   * full rationale (fixes the bait-and-switch UX bug where a per-station
   * fuel page would get replaced by the generic fuel comparator on hydrate).
   *
   * Set to false only for callers that genuinely need React to hydrate
   * the SEO content area as part of the SPA tree (none currently).
   */
  seoContentOutsideRoot?: boolean;
  /**
   * When provided, the caller's `bodyHtml` is wrapped in the canonical hub
   * sub-navigation bar (and optional hero strip) so the static first-paint
   * matches the SPA chrome for the target hub. See {@link renderHubChrome}
   * for the full rationale (BUG-2 fix).
   *
   * The wrapping is applied to `bodyHtml` BEFORE the outer
   * `<main class="seo-static-content">` sibling emitted by
   * `seoContentOutsideRoot` mode. That keeps the existing lite-shell
   * detection hook (`main.seo-static-content` presence) working unchanged.
   */
  hubChrome?: {
    readonly hubKey: HubKey;
    readonly activeSubTab: string;
    readonly hero?: HubHero;
  };
  /**
   * When true, propagates `data-no-auto-ads` to the rendered `<body>` so
   * Google AdSense Auto Ads skip the entire page. Set on drive-by SEO
   * templates (border wait, fuel daily, health premiums) where engagement
   * is too low for ad serving to earn — frees frequency caps for engaged
   * pages and avoids hurting the AdSense quality score with high-bounce
   * impressions.
   */
  disableAutoAds?: boolean;
  /**
   * Class applied to the `<main>` wrapper emitted around `bodyHtml` when
   * {@link seoContentOutsideRoot} is true. Defaults to `'seo-static-content'`,
   * which the SPA's `useNavigationState` hook detects to switch to lite-shell
   * mode (header + footer only, leaves static content visible).
   *
   * Pass a different class (e.g. `'cluster-seo-prose'`) to opt OUT of
   * lite-shell — the SPA hydrates `#root` with its full UI and the static
   * `<main>` lives below `#root` purely as crawler-facing prose. Used by
   * the per-cluster related-search pages whose interactive UI (working
   * searchbar + filters) is rendered by the SPA's JobBoard component.
   */
  seoMainClass?: string;
}

/**
 * Build a full SEO HTML page with SPA shell wrapping.
 *
 * Delegates the boilerplate to {@link buildSimplePage}, which guarantees:
 *
 *   - `<body>` carries the site theme class (via the canonical template)
 *   - `<div id="root">` wraps the content so React can hydrate
 *   - Entry JS/CSS are injected so the SPA nav header + footer render
 *   - Analytics, AdSense, GTAG, canonical, OG and favicon tags are emitted
 *
 * The caller passes the page-specific content (including its own `<main>`
 * or plain inner HTML). buildSimplePage wraps everything in
 * `<div id="root"><main class="static-job-page">${bodyHtml}</main></div>`.
 */
export function buildSeoPageHtml(opts: SeoPageShellOpts): string {
  const {
    locale,
    title,
    description,
    canonicalUrl,
    hreflangHtml,
    bodyHtml,
    jsonLdScripts,
    extraHeadHtml,
    ogImage,
    ogImageWidth,
    ogImageHeight,
    ogImageType,
    ogImageAlt,
    ogLocale,
    robots = 'index,follow',
    ogType = 'website',
    distDir,
    skipMainWrap = true,
    // Default ON for all SEO feature pages — keeps the static SEO content
    // safe from React's hydration overwriting it inside `#root`. See
    // SimplePageOpts.seoContentOutsideRoot for the full rationale.
    seoContentOutsideRoot = true,
    hubChrome,
    disableAutoAds = false,
    seoMainClass,
  } = opts;

  const assets = distDir ? resolveEntryAssets(distDir) : { entryJs: '', entryCss: '' };

  // Split hub chrome: sub-nav is hoisted OUT of <main> via `preMainHtml` so it
  // renders as a sibling (same DOM shape as the SPA), while hero + inner
  // content stay INSIDE <main class="seo-static-content">.
  const { subnavHtml, bodyHtml: wrappedBody } = hubChrome
    ? renderHubChromeSplit({
        hubKey: hubChrome.hubKey,
        activeSubTab: hubChrome.activeSubTab,
        locale: locale as HubLocale,
        hero: hubChrome.hero,
        innerHtml: bodyHtml,
      })
    : { subnavHtml: '', bodyHtml };

  const simpleOpts: SimplePageOpts = {
    locale,
    title: normalizeShellTitle(title),
    description,
    canonicalUrl,
    robots,
    ogType,
    ogLocale,
    hreflangHtml: hreflangHtml ?? '',
    ogImage,
    ogImageWidth,
    ogImageHeight,
    ogImageType,
    ogImageAlt,
    extraHeadHtml: extraHeadHtml ?? '',
    jsonLdScripts: jsonLdScripts ?? [],
    entryJs: assets.entryJs || undefined,
    entryCss: assets.entryCss || undefined,
    bodyHtml: wrappedBody,
    preMainHtml: subnavHtml,
    skipMainWrap,
    seoContentOutsideRoot,
    disableAutoAds,
    ...(seoMainClass !== undefined ? { seoMainClass } : {}),
  };

  return minifyHtml(buildSimplePage(simpleOpts));
}
