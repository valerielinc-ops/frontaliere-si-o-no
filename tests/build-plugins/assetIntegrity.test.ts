import { afterEach, describe, expect, it } from 'vitest';
import {
  addIntegrityToHtml,
  assetIntegritySnapshot,
  integrityAttributeForAsset,
  registerAssetIntegrity,
  resetAssetIntegrityForTests,
  sriIntegrity,
} from '@/build-plugins/shared/assetIntegrity';

// SRI on stable asset names is disabled: on 2026-10-08 the HTML of the live
// build pinned hashes of assets/index-entry.js that the next build's early CDN
// push had already overwritten, and every page stopped executing JavaScript.
// These tests pin the disabled contract; if you re-enable SRI, asset URLs must
// be content-addressed first.
describe('asset integrity helper (disabled for stable asset names)', () => {
  afterEach(() => {
    resetAssetIntegrityForTests();
  });

  it('registers nothing, so no emitter can pin a stable asset URL', () => {
    registerAssetIntegrity('assets/index.css', 'body { color: #123; }');

    expect(assetIntegritySnapshot().size).toBe(0);
    expect(integrityAttributeForAsset('/assets/index.css?v=stable')).toBe('');
    expect(integrityAttributeForAsset('https://cdn.frontaliereticino.ch/assets/index.css')).toBe('');
  });

  it('adds no integrity attribute to asset tags', () => {
    registerAssetIntegrity('assets/index-entry.js', 'export const ready = true;');
    const html = [
      '<link rel="stylesheet" href="https://cdn.frontaliereticino.ch/assets/index.css">',
      '<script type="module" crossorigin src="https://cdn.frontaliereticino.ch/assets/index-entry.js"></script>',
      '<script src="https://example.com/third-party.js"></script>',
    ].join('\n');

    expect(addIntegrityToHtml(html)).toBe(html);
  });

  it('removes a hash already written on first-party asset tags (the outage shape)', () => {
    const stale = sriIntegrity('bytes of the previous build');
    const html = [
      `<script type="module" crossorigin fetchpriority="high" src="https://cdn.frontaliereticino.ch/assets/index-entry.js" integrity="${stale}"></script>`,
      `<link rel="modulepreload" href="https://cdn.frontaliereticino.ch/assets/App.js" crossorigin="anonymous" integrity="${stale}">`,
      `<link rel="stylesheet" href="/assets/critical.css" integrity="${stale}" />`,
    ].join('\n');

    const cleaned = addIntegrityToHtml(html);
    expect(cleaned).not.toContain('integrity=');
    expect(cleaned).toBe(
      [
        '<script type="module" crossorigin fetchpriority="high" src="https://cdn.frontaliereticino.ch/assets/index-entry.js"></script>',
        '<link rel="modulepreload" href="https://cdn.frontaliereticino.ch/assets/App.js" crossorigin="anonymous">',
        '<link rel="stylesheet" href="/assets/critical.css" />',
      ].join('\n'),
    );
    expect(addIntegrityToHtml(cleaned)).toBe(cleaned);
  });

  it('NEGATIVE CASE — leaves third-party integrity untouched', () => {
    const html = [
      '<script src="https://example.com/assets/lib.js" integrity="sha384-thirdparty" crossorigin="anonymous"></script>',
      '<script src="https://example.com/third-party.js" integrity="sha384-other"></script>',
    ].join('\n');

    expect(addIntegrityToHtml(html)).toBe(html);
  });
});
