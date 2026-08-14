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
 * `entryFileNames`/`assetFileNames`, see `./spaEntryFilenames.ts`) — known
 * at config-authoring time, not discovered from a build artifact.
 * {@link resolveEntryAssets} just returns those constants; it does not
 * check `dist/assets/` at all.
 *
 * A prior version gated this on `fs.existsSync(dist/assets/<file>)` at
 * closeBundle time, on the theory that plain asset files are reliably
 * present there. That theory turned out to be false for this build: on
 * 2026-07-26, `dist/assets/index-entry.js` / `index.css` were repeatedly
 * still absent from disk when closeBundle-time plugins ran (Rollup's write
 * phase not yet finished, see `spaBundleResolver.ts` header for the
 * incident detail) — and because this function degrades to `''` instead
 * of throwing, that race silently stripped the SPA hydration `<script>`/
 * `<link>` tags from SEO pages instead of failing the build loudly. Since
 * callers only need the filename *string* (Rollup guarantees the file
 * exists by the time the `vite build` process exits, long after any HTML
 * referencing it was generated), there is no correctness reason to gate on
 * disk state mid-build at all. Actual presence on disk is verified once,
 * after the whole build process exits, by
 * `scripts/verify-spa-entry-assets.mjs`.
 *
 * {@link resolveEntryAssets} caches the result per-build (keyed by distDir)
 * purely to keep the Map-based API tests already exercise; the underlying
 * lookup is a plain constant return, not a disk check.
 */

import np from 'node:path';
import { buildSimplePage, type SimplePageOpts } from '../htmlTemplate';
import { renderHubChromeSplit, type HubKey, type HubLocale, type HubHero } from './hubChrome';
import { normalizeShellTitle } from './titleSuffix';
import { minifyHtml } from './htmlMinify';
import { SPA_ENTRY_JS_FILENAME, SPA_ENTRY_CSS_FILENAME } from './spaEntryFilenames';

// `normalizeShellTitle` vive ora in ./titleSuffix.ts (modulo foglia), cosi'
// che l'invariante di round-trip col confronto h1/title di
// `differentiateH1FromTitle` sia testabile senza trascinarsi dietro la
// superficie di asset SSG di questo modulo (htmlTemplate → constants legge
// `public/assets/**` a module scope). Vedi il suo docblock e
// `tests/seo/h1-title-brand-roundtrip.test.ts` — #5831 item 4.
//
// Il default di `measureLength` la' dentro e' un escape inline byte-identico
// all' `esc` di htmlTemplate usato prima qui (stesse quattro sostituzioni,
// stesso ordine): il budget resta misurato sulla stringa ESCAPED. E' inline e
// non importato perche' titleSuffix.ts e' `mode: identical` e va copiato a
// mano sul corpus, dove `shared/htmlEscape.ts` non esiste — vedi il suo
// docblock. L'equivalenza fra le due copie e' pinnata dal test.

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
 * `assetFileNames` — see `./spaEntryFilenames.ts`) — known at
 * config-authoring time, so this returns them directly with no disk I/O.
 * Actual on-disk presence is verified once, post-build, by
 * `scripts/verify-spa-entry-assets.mjs`.
 */
export function resolveEntryAssets(distDir: string): EntryAssets {
  const cached = ENTRY_CACHE.get(distDir);
  if (cached) return cached;

  const out: EntryAssets = { entryJs: SPA_ENTRY_JS_FILENAME, entryCss: SPA_ENTRY_CSS_FILENAME };
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
