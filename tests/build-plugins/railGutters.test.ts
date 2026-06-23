import { describe, expect, it } from 'vitest';
import { railGutters } from '../../build-plugins/shared/railGutters';

/**
 * Shared side-rail gutter markup used by BOTH static-page emitters
 * (htmlTemplate.ts / buildSimplePage AND staticPagesPlugin.ts hubChromeSplit).
 * Extracted into one module so the grid + portal ids can't drift apart; this
 * unit test pins the contract App.tsx's #rail-left-root / #rail-right-root
 * portal depends on. The end-to-end seoPageShell path is covered by
 * tests/regression/static-seo-rail-ads.test.ts; the dist path by
 * tests/dist-static-overlay-rail-ads.test.ts.
 */
describe('railGutters() shared markup', () => {
  it('emits both portal targets in the xlw 3-col grid when enabled', () => {
    const { open, close } = railGutters(true);

    expect(open).toContain('rail-left-root');
    expect(close).toContain('rail-right-root');
    // The reserved 3-column grid only materialises at the xlw (≥1400px) tier.
    expect(open).toMatch(/xlw:grid-cols-\[300px_minmax\(0,1fr\)_300px\]/);
    // open precedes <main>, close follows it → left | main | right ordering.
    expect(open).toContain('ft-rail-grid');
    expect(close).toContain('</div>');
  });

  it('suppresses both gutters when disabled (disableAutoAds drive-by opt-out)', () => {
    const { open, close } = railGutters(false);

    expect(open).toBe('');
    expect(close).toBe('');
  });
});
