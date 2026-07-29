import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADSENSE_LOADER_FILENAME,
  BRIDGE_CSS_FILENAME,
  BRIDGE_CSS_LINK,
  EARLY_BOOT_FILENAME,
  FUEL_CHART_SCRIPT_FILENAME,
  GTAG_INIT_FILENAME,
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
 * ever grows a hash again, this fails the moment the constant changes.
 */
describe('stable asset filenames', () => {
  it.each([
    [SEO_STATIC_CSS_FILENAME, 'seo-static.css'],
    [BRIDGE_CSS_FILENAME, 'bridge.css'],
    [EARLY_BOOT_FILENAME, 'early-boot.js'],
    [FUEL_CHART_SCRIPT_FILENAME, 'fuel-chart.js'],
    [GTAG_INIT_FILENAME, 'gtag-init.js'],
    [POSTHOG_INIT_FILENAME, 'posthog-init.js'],
    [ADSENSE_LOADER_FILENAME, 'adsense-loader.js'],
  ])('%s is the stable name %s', (actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('link tags reference the stable /assets/ paths', () => {
    expect(SEO_STATIC_CSS_LINK).toBe('<link rel="stylesheet" href="/assets/seo-static.css">');
    expect(BRIDGE_CSS_LINK).toBe('<link rel="stylesheet" href="/assets/bridge.css">');
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
