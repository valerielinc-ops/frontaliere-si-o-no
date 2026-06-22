import { describe, expect, it } from 'vitest';
import { buildSeoPageHtml } from '../../build-plugins/shared/seoPageShell';

/**
 * Full-height left/right side-rail ad gutters on static SEO landing pages.
 *
 * buildSeoPageHtml emits (seoContentOutsideRoot mode) a 3-column rail grid that
 * wraps <main seo-static-content> with two <aside> portal targets
 * (#rail-left-root / #rail-right-root). App.tsx mounts <ArticleRailAdStack> into
 * them on staticOverlay pages — same portal pattern as the #footer-root.
 *
 * The grid is CSS-gated to xlw (≥1400px) so narrower viewports keep a single,
 * unchanged column; drive-by pages (disableAutoAds) opt out of the rails.
 */
describe('static SEO landing pages — full-height side-rail ad gutters', () => {
  const baseOpts = {
    locale: 'en',
    title: 'Lidl jobs in Ticino',
    description: 'Open Lidl positions for cross-border workers in Ticino.',
    canonicalUrl: 'https://frontaliereticino.ch/en/find-jobs-ticino/company-lidl/',
    bodyHtml: '<h1>Lidl jobs</h1><p>Listings…</p>',
  };

  it('wraps the static <main> in the xlw rail grid with both portal targets', () => {
    const html = buildSeoPageHtml(baseOpts);

    expect(html).toContain('rail-left-root');
    expect(html).toContain('rail-right-root');
    // The reserved 3-column grid only materialises at the xlw (≥1400px) tier.
    expect(html).toMatch(/xlw:grid-cols-\[300px_minmax\(0,1fr\)_300px\]/);
    // <main> stays present (lite-shell detection hook depends on it) and the
    // footer portal target still follows the content.
    expect(html).toContain('seo-static-content');
    expect(html).toContain('footer-root');
  });

  it('orders the rails around the centre <main>: left | main | right', () => {
    const html = buildSeoPageHtml(baseOpts);
    const left = html.indexOf('rail-left-root');
    const main = html.indexOf('seo-static-content');
    const right = html.indexOf('rail-right-root');
    const footer = html.indexOf('footer-root');

    expect(left).toBeGreaterThan(-1);
    expect(left).toBeLessThan(main);
    expect(main).toBeLessThan(right);
    expect(right).toBeLessThan(footer);
  });

  it('suppresses the rails on drive-by pages (disableAutoAds opt-out)', () => {
    const html = buildSeoPageHtml({ ...baseOpts, disableAutoAds: true });

    expect(html).not.toContain('rail-left-root');
    expect(html).not.toContain('rail-right-root');
    // Static content + footer portal remain intact.
    expect(html).toContain('seo-static-content');
    expect(html).toContain('footer-root');
  });
});
