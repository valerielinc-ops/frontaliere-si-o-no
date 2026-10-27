import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPA_ENTRY_CSS_FILENAME, SPA_ENTRY_JS_FILENAME } from '@/build-plugins/shared/spaEntryFilenames';
import {
  VERSIONED_RELEASE_ENTRY,
  VERSIONED_RELEASES_DIR,
  buildVersionedBootstrap,
} from '@/build-plugins/versionedCdnAssetsPlugin';

const ROOT = resolve(import.meta.dirname, '../..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

function ruleBlock(source: string, selector: string): string[] {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === selector);
  expect(start, `${selector} must be declared in public/_headers`).toBeGreaterThanOrEqual(0);

  const end = lines.findIndex(
    (line, index) => index > start && /^\/.+/.test(line.trim()),
  );
  return lines.slice(start, end === -1 ? lines.length : end);
}

function cacheControl(block: string[]): string {
  const line = block.find((candidate) => /^Cache-Control:/i.test(candidate.trim()));
  expect(line, 'each asset rule must declare Cache-Control').toBeTruthy();
  return line!.trim().replace(/^Cache-Control:\s*/i, '');
}

describe('stable/release asset naming and cache contract', () => {
  const viteSource = readRepoFile('vite.config.ts');
  const headers = readRepoFile('public/_headers');
  const docs = readRepoFile('docs/SEO-FEATURES.md');
  const staticScriptsSource = readRepoFile('build-plugins/staticScriptsPlugin.ts');
  const criticalCssSource = readRepoFile('build-plugins/shared/criticalCss.ts');

  it('keeps every HTML-referenced root asset on a stable basename', () => {
    expect(SPA_ENTRY_JS_FILENAME).toBe('index-entry.js');
    expect(SPA_ENTRY_CSS_FILENAME).toBe('index.css');

    const stableRootAssets = [
      SPA_ENTRY_JS_FILENAME,
      SPA_ENTRY_CSS_FILENAME,
      'critical.css',
      'seo-static.css',
      'bridge.css',
    ];

    for (const asset of stableRootAssets) {
      expect(asset, `${asset} must not carry a content hash`).not.toMatch(/-[0-9a-f]{8,}(?=\.)/i);
    }

    expect(viteSource).toContain('entryFileNames: `assets/${SPA_ENTRY_JS_FILENAME}`');
    expect(viteSource).toContain('chunkFileNames: (chunk) =>');
    expect(viteSource).toContain('return buildBlogBodyChunkFileName(safe, m)');
    expect(viteSource).toContain("if (n.endsWith('.css')) return 'assets/[name][extname]'");
    expect(viteSource).toContain("return 'assets/[name]-[hash][extname]'");
    expect(criticalCssSource).toContain("export const CRITICAL_CSS_FILENAME = 'critical.css'");
    expect(staticScriptsSource).toContain('[CRITICAL_CSS_FILENAME, CRITICAL_CSS]');
    expect(staticScriptsSource).toContain('apply: \'build\'');
  });

  it('keeps Vite releases, CDN headers and documentation on one policy', () => {
    const releaseBlock = ruleBlock(headers, `/assets/${VERSIONED_RELEASES_DIR}/*`);
    const rootBlock = ruleBlock(headers, '/assets/*');
    const releaseSelectorAt = headers.indexOf(`/assets/${VERSIONED_RELEASES_DIR}/*`);
    const rootSelectorAt = headers.indexOf('/assets/*');

    expect(releaseSelectorAt).toBeGreaterThanOrEqual(0);
    expect(rootSelectorAt).toBeGreaterThan(releaseSelectorAt);
    expect(cacheControl(releaseBlock)).toBe('public, max-age=31536000, immutable');
    expect(cacheControl(rootBlock)).toBe('public, max-age=600, must-revalidate');
    expect(cacheControl(rootBlock)).not.toContain('immutable');

    expect(viteSource).toContain('versionedCdnAssetsPlugin(__dirname)');
    expect(buildVersionedBootstrap('https://cdn.frontaliereticino.ch', '1793012345678')).toContain(
      `/assets/${VERSIONED_RELEASES_DIR}/1793012345678/${VERSIONED_RELEASE_ENTRY}`,
    );

    for (const documentedContract of [
      '/assets/index-entry.js',
      '/assets/index.css',
      '/assets/critical.css',
      '/assets/releases/<DEPLOY_BUILD_ID>/',
      'public, max-age=600, must-revalidate',
      'public, max-age=31536000, immutable',
    ]) {
      expect(docs, `SEO-FEATURES.md must document ${documentedContract}`).toContain(documentedContract);
    }
  });
});
