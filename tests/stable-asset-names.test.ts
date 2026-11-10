import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AD_RECOVERY_FILENAME,
  AD_RECOVERY_VERSIONED_FILENAME,
  ADSENSE_LOADER_FILENAME,
  ADSENSE_LOADER_VERSIONED_FILENAME,
  BRIDGE_CSS_FILENAME,
  BRIDGE_CSS_LINK,
  EARLY_BOOT_FILENAME,
  FUEL_CHART_SCRIPT_FILENAME,
  GTAG_INIT_CONTENT,
  GTAG_INIT_FILENAME,
  GTAG_INIT_VERSIONED_FILENAME,
  GTAG_INIT_URL,
  GTAG_SNIPPET,
  META_PIXEL_LOADER_FILENAME,
  META_PIXEL_LOADER_VERSIONED_FILENAME,
  PARTNERIZE_TAG_FILENAME,
  PARTNERIZE_TAG_VERSIONED_FILENAME,
  POSTHOG_INIT_FILENAME,
  SEO_STATIC_CSS_FILENAME,
  SEO_STATIC_CSS_LINK,
} from '@/build-plugins/constants';
import { findChunkFile, findChunkFiles } from '@/build-plugins/shared/chunkFiles';
import { SPA_ENTRY_JS_FILENAME } from '@/build-plugins/shared/spaEntryFilenames';

/**
 * Pins the STABLE-filename policy (vite.config.ts chunkFileNames /
 * assetFileNames + constants.ts): every bundler asset referenced by the
 * prerendered pages ships under a name with NO content hash. A re-hashed name
 * would (a) re-churn the ~1.28M prerendered pages that embed it and (b) 404
 * from HTML still cached under the previous name once the CDN janitor prunes
 * it — the two failure classes the stabilization removed. If a filename below
 * ever grows a hash again, this fails the moment the constant changes. Global
 * scripts retain content-addressed copies for old HTML, while newly emitted
 * pages use stable aliases with bounded cache lifetimes.
 */
describe('stable asset filenames', () => {
  it.each([
    [SEO_STATIC_CSS_FILENAME, 'seo-static.css'],
    [BRIDGE_CSS_FILENAME, 'bridge.css'],
    [EARLY_BOOT_FILENAME, 'early-boot.js'],
    [FUEL_CHART_SCRIPT_FILENAME, 'fuel-chart.js'],
    [GTAG_INIT_FILENAME, 'gtag-init.js'],
    [AD_RECOVERY_FILENAME, 'site-support.js'],
    [POSTHOG_INIT_FILENAME, 'posthog-init.js'],
    [ADSENSE_LOADER_FILENAME, 'adsense-loader.js'],
    [PARTNERIZE_TAG_FILENAME, 'partnerize-tag.js'],
    [META_PIXEL_LOADER_FILENAME, 'meta-pixel-base-code.js'],
  ])('%s is the stable name %s', (actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('link tags reference the stable /assets/ paths', () => {
    expect(SEO_STATIC_CSS_LINK).toBe('<link rel="stylesheet" href="/assets/seo-static.css">');
    expect(BRIDGE_CSS_LINK).toBe('<link rel="stylesheet" href="/assets/bridge.css">');
  });

  it('keeps a content-addressed GA4 copy while HTML references the stable alias', () => {
    const expectedHash = createHash('sha256').update(GTAG_INIT_CONTENT).digest('hex').slice(0, 12);

    expect(GTAG_INIT_VERSIONED_FILENAME).toBe(`gtag-init-${expectedHash}.js`);
    expect(GTAG_INIT_URL).toBe('/assets/gtag-init.js');
    expect(GTAG_SNIPPET).toContain(`<script defer src="${GTAG_INIT_URL}"></script>`);
    expect(GTAG_SNIPPET).not.toContain(GTAG_INIT_VERSIONED_FILENAME);
    expect(AD_RECOVERY_VERSIONED_FILENAME).toMatch(/^site-support-[a-f0-9]{12}\.js$/);
    expect(ADSENSE_LOADER_VERSIONED_FILENAME).toMatch(/^adsense-loader-[a-f0-9]{12}\.js$/);
    expect(PARTNERIZE_TAG_VERSIONED_FILENAME).toMatch(/^partnerize-tag-[a-f0-9]{12}\.js$/);
    expect(META_PIXEL_LOADER_VERSIONED_FILENAME).toMatch(/^meta-pixel-base-code-[a-f0-9]{12}\.js$/);

    const staticScriptsSource = fs.readFileSync(
      path.join(process.cwd(), 'build-plugins', 'staticScriptsPlugin.ts'),
      'utf-8',
    );
    expect(staticScriptsSource).toContain('[GTAG_INIT_VERSIONED_FILENAME, GTAG_INIT_CONTENT]');
    expect(staticScriptsSource).toContain('[GTAG_INIT_FILENAME, GTAG_INIT_CONTENT]');
    expect(staticScriptsSource).toContain('[META_PIXEL_LOADER_VERSIONED_FILENAME, META_PIXEL_LOADER_CONTENT]');
    expect(staticScriptsSource).toContain('[META_PIXEL_LOADER_FILENAME, META_PIXEL_LOADER_CONTENT]');
  });

  it('the stylesheet sources exist in public/assets/ (Vite copies them verbatim to dist)', () => {
    for (const f of ['seo-static.css', 'bridge.css']) {
      expect(
        fs.existsSync(path.join(process.cwd(), 'public', 'assets', f)),
        `public/assets/${f} must exist — the SEO pages reference /assets/${f}`,
      ).toBe(true);
    }
  });

  it('vite.config.ts pins stable chunk and CSS names', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'vite.config.ts'), 'utf-8');
    expect(src).toContain('entryFileNames: `assets/${SPA_ENTRY_JS_FILENAME}`');
    expect(SPA_ENTRY_JS_FILENAME).toBe('index-entry.js');
    // chunkFileNames is a function: stable default + locale-qualified
    // blog-body chunks (their basenames collide across the 4 locale dirs).
    // The basename is routed through adFilterSafeChunkName (issue #2971) — a
    // deterministic 1:1 substring swap that keeps names STABLE while making them
    // invisible to ad-block network filters; it is a no-op for non-tracker names.
    expect(src).toContain("import { adFilterSafeChunkName } from './build-plugins/shared/adFilterSafeChunkName'");
    expect(src).toContain("const safe = adFilterSafeChunkName(chunk.name ?? '')");
    // Locale-key matching/naming itself is delegated to
    // build-plugins/shared/blogBodyChunkNaming.ts (issue #4881 Fase 6 review
    // fix — extracted so both the legacy services/locales/blog-body path AND
    // the real, symlink-resolved packages/articles/content/blog-body path can
    // be pinned by a unit test without running a build; see
    // tests/vite-chunk-blog-body-locale-naming.test.ts for that coverage).
    expect(src).toContain(
      "import { matchBlogBodyChunkLocale, buildBlogBodyChunkFileName } from './build-plugins/shared/blogBodyChunkNaming'",
    );
    expect(src).toContain('const m = matchBlogBodyChunkLocale(chunk.facadeModuleId)');
    expect(src).toContain('return buildBlogBodyChunkFileName(safe, m)');
    // All stylesheets stable; only non-CSS bundler assets keep the hash.
    expect(src).toContain("if (n.endsWith('.css')) return 'assets/[name][extname]'");
  });

  it('does not publish source maps unless a controlled build opts in', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'vite.config.ts'), 'utf-8');
    expect(src).toContain("sourcemap: process.env.PUBLIC_SOURCEMAPS === '1'");
    expect(src).not.toContain('sourcemap: true');
  });
});

describe('findChunkFile / findChunkFiles', () => {
  const files = [
    'index-entry.js',
    'App.js',
    'it-core.js',
    'vendor-react.js',
    'vendor-react.js.map',
    'blog-meta-it-aB3_x9Yz.js', // legacy hashed dist (audit replay of old artifact)
    'blog-meta-it-aB3_x9Yz.js.map',
    'index.css',
  ];

  it('resolves the stable name first', () => {
    expect(findChunkFile(files, 'App')).toBe('App.js');
    expect(findChunkFile(files, 'vendor-react')).toBe('vendor-react.js');
  });

  it('falls back to the legacy hashed name', () => {
    expect(findChunkFile(files, 'blog-meta-it')).toBe('blog-meta-it-aB3_x9Yz.js');
  });

  it('never matches sourcemaps and returns undefined for absent chunks', () => {
    expect(findChunkFile(files, 'vendor-react.js')).toBeUndefined();
    expect(findChunkFile(files, 'vendor-charts')).toBeUndefined();
  });

  it('preserves order and drops missing names', () => {
    expect(findChunkFiles(files, ['it-core', 'missing', 'App'])).toEqual(['it-core.js', 'App.js']);
  });
});
