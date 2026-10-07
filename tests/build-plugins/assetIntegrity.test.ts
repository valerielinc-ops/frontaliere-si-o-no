import { afterEach, describe, expect, it } from 'vitest';
import {
  addIntegrityToHtml,
  integrityAttributeForAsset,
  registerAssetIntegrity,
  resetAssetIntegrityForTests,
  sriIntegrity,
} from '@/build-plugins/shared/assetIntegrity';

describe('asset integrity helper', () => {
  afterEach(() => {
    resetAssetIntegrityForTests();
  });

  it('uses one sha384 identity for relative and CDN asset URLs', () => {
    const bytes = 'body { color: #123; }';
    const expected = sriIntegrity(bytes);
    registerAssetIntegrity('assets/index.css', bytes);

    expect(integrityAttributeForAsset('/assets/index.css?v=stable')).toBe(
      ` integrity="${expected}"`,
    );
    expect(integrityAttributeForAsset('https://cdn.frontaliereticino.ch/assets/index.css')).toBe(
      ` integrity="${expected}"`,
    );
  });

  it('patches asset links and scripts once, adding crossorigin when needed', () => {
    const bytes = 'export const ready = true;';
    const integrity = sriIntegrity(bytes);
    registerAssetIntegrity('assets/index-entry.js', bytes);
    const html = [
      '<link rel="stylesheet" href="https://cdn.frontaliereticino.ch/assets/index-entry.js">',
      '<script type="module" src="https://cdn.frontaliereticino.ch/assets/index-entry.js"></script>',
      '<script type="module" crossorigin src="https://cdn.frontaliereticino.ch/assets/index-entry.js"></script>',
      '<script src="https://example.com/third-party.js"></script>',
    ].join('\n');

    const patched = addIntegrityToHtml(html);
    expect(patched).toContain(`crossorigin="anonymous" integrity="${integrity}"`);
    expect(patched).toContain(
      `<script type="module" crossorigin src="https://cdn.frontaliereticino.ch/assets/index-entry.js" integrity="${integrity}"></script>`,
    );
    expect(patched).toContain('<script src="https://example.com/third-party.js"></script>');
    expect(addIntegrityToHtml(patched)).toBe(patched);
  });

  it('refreshes a previous hash when a stable asset is rebuilt', () => {
    registerAssetIntegrity('assets/critical.css', 'new bytes');
    const patched = addIntegrityToHtml(
      '<link rel="stylesheet" href="/assets/critical.css" integrity="sha384-old" />',
    );

    expect(patched).toBe(
      `<link rel="stylesheet" href="/assets/critical.css" crossorigin="anonymous" integrity="${sriIntegrity('new bytes')}" />`,
    );
  });
});
