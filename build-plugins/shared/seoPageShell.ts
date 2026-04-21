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
 * Vite emits `/dist/index.html` before any `closeBundle` hook fires. All 6
 * feature plugins run in `closeBundle`, so we can safely read `dist/index.html`
 * and extract the hashed entry JS/CSS via regex — mirrors the pattern used
 * by staticPagesPlugin.ts and jobsSeoPagesPlugin.ts.
 *
 * {@link resolveEntryAssets} caches the result per-build (keyed by distDir)
 * so each plugin doesn't re-read the same index.html for every page it emits.
 */

import fs from 'node:fs';
import np from 'node:path';
import { buildSimplePage, type SimplePageOpts } from '../htmlTemplate';

/** Cached entry-asset resolution, keyed by distDir absolute path. */
interface EntryAssets {
  entryJs: string;
  entryCss: string;
}

const ENTRY_CACHE = new Map<string, EntryAssets>();

/**
 * Resolve the hashed entry JS + CSS from Vite's dist/index.html.
 *
 * Vite names the top-level entry `index-{hash}.js` / `index-{hash}.css` (not
 * `App-*`). We extract them from the already-generated `dist/index.html`
 * because Vite may emit other `index-*.js` chunks and scanning the assets
 * directory with a filename filter picks the wrong file. Reading the real
 * HTML `<script>` / `<link>` tags is the canonical approach — same trick
 * used by staticPagesPlugin.ts.
 *
 * Returns empty strings if `dist/index.html` does not exist (e.g. test
 * environment). buildSimplePage tolerates empty entry asset paths by
 * omitting the script/link tags — the page still renders SEO content.
 */
export function resolveEntryAssets(distDir: string): EntryAssets {
  const cached = ENTRY_CACHE.get(distDir);
  if (cached) return cached;

  let entryJs = '';
  let entryCss = '';
  try {
    const indexHtmlPath = np.join(distDir, 'index.html');
    const built = fs.readFileSync(indexHtmlPath, 'utf-8');
    entryJs = built.match(/src="\/assets\/(index-[A-Za-z0-9_-]+\.js)"/)?.[1] ?? '';
    entryCss = built.match(/href="\/assets\/(index-[A-Za-z0-9_-]+\.css)"/)?.[1] ?? '';
  } catch {
    // dist/index.html missing — tests run without a prior Vite build.
    // buildSimplePage handles empty strings by skipping the hydration tags.
  }

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
  /** Additional `<head>` HTML (extra meta, Twitter cards, prev/next, etc.). */
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
   */
  skipMainWrap?: boolean;
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
    ogLocale,
    robots = 'index,follow',
    ogType = 'website',
    distDir,
    skipMainWrap = true,
  } = opts;

  const assets = distDir ? resolveEntryAssets(distDir) : { entryJs: '', entryCss: '' };

  const simpleOpts: SimplePageOpts = {
    locale,
    title,
    description,
    canonicalUrl,
    robots,
    ogType,
    ogLocale,
    hreflangHtml: hreflangHtml ?? '',
    extraHeadHtml: extraHeadHtml ?? '',
    jsonLdScripts: jsonLdScripts ?? [],
    entryJs: assets.entryJs || undefined,
    entryCss: assets.entryCss || undefined,
    bodyHtml,
    skipMainWrap,
  };

  return buildSimplePage(simpleOpts);
}
