/**
 * Regression: F8 webcam figure is responsive and uses referrerpolicy="no-referrer"
 *
 * Before the fix the webcam <figure> had no constrained aspect ratio so it
 * collapsed to zero height when the image was blocked (ti.ch hotlink 403),
 * and the <img> lacked referrerpolicy which caused Ticino DoT webcams to
 * return 403 (hotlink protection keyed on the Referer header). The SVG
 * fallback also lacked a viewBox so it rendered as a 0×0 element.
 *
 * The fix:
 *  - <figure style="...aspect-ratio:16/9;max-width:640px">
 *  - <img referrerpolicy="no-referrer" ...>
 *  - SVG onerror fallback includes viewBox="0 0 640 360"
 *
 * This suite calls generateBorderWaitPages() with a minimal synthetic
 * dataset and asserts the rendered HTML for a crossing with webcams.
 */

import { describe, it, expect } from 'vitest';
import {
  generateBorderWaitPages,
  type BorderWaitCurrent,
} from '../../build-plugins/borderWaitPagesPlugin';
import { buildOggiPath } from '../../build-plugins/borderWaitData';

// ── Minimal synthetic dataset ────────────────────────────────────────
// chiasso-brogeda has 3 webcams in data/borderCrossings.ts so it's a
// reliable fixture for the webcam assertions.
const CURRENT: BorderWaitCurrent = {
  updatedAt: '2026-04-21T06:00:00.000Z',
  perCrossing: {
    'chiasso-brogeda': {
      waitTimeMinutes: 5,
      source: 'tomtom',
      lastUpdate: '2026-04-21T06:00:00.000Z',
      status: 'green',
    },
  },
};

const pages = generateBorderWaitPages({
  current: CURRENT,
  today: new Date('2026-04-21T06:00:00.000Z'),
});

const BROGEDA_IT = pages[buildOggiPath('it', 'chiasso-brogeda')];

describe('F8 webcam — referrerpolicy', () => {
  it('chiasso-brogeda IT page is generated', () => {
    expect(typeof BROGEDA_IT).toBe('string');
    expect(BROGEDA_IT.length).toBeGreaterThan(0);
  });

  it('<img> carries referrerpolicy="no-referrer"', () => {
    // This attribute bypasses the ti.ch hotlink-protection check that
    // sends 403 when a Referer header is present.
    expect(BROGEDA_IT).toContain('referrerpolicy="no-referrer"');
  });

  it('every webcam <img> on this page has referrerpolicy="no-referrer"', () => {
    // Extract all <img> tags and ensure each one has the attribute.
    const imgTags = [...BROGEDA_IT.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
    // There should be at least one webcam img
    const webcamImgs = imgTags.filter((tag) => tag.includes('data-webcam-refresh'));
    expect(webcamImgs.length).toBeGreaterThanOrEqual(1);
    for (const img of webcamImgs) {
      expect(img, `img missing referrerpolicy: ${img.slice(0, 100)}`).toContain(
        'referrerpolicy="no-referrer"',
      );
    }
  });
});

describe('F8 webcam — responsive figure wrapper', () => {
  it('<figure> wrapper has aspect-ratio:16/9', () => {
    // The figure must constrain aspect ratio so the layout does not collapse
    // when the webcam image fails to load.
    expect(BROGEDA_IT).toMatch(/aspect-ratio:16\/9/);
  });

  it('<figure> wrapper has max-width:640px', () => {
    expect(BROGEDA_IT).toContain('max-width:640px');
  });

  it('<figure> wrapper has both aspect-ratio and max-width on the same element', () => {
    // Check that a single figure element has both constraints together.
    const figureMatch = BROGEDA_IT.match(/<figure[^>]+>/);
    expect(figureMatch).not.toBeNull();
    const figureTag = figureMatch![0];
    expect(figureTag).toContain('aspect-ratio:16/9');
    expect(figureTag).toContain('max-width:640px');
  });
});

describe('F8 webcam — SVG fallback has viewBox', () => {
  it('onerror SVG placeholder contains viewBox="0 0 640 360"', () => {
    // Without viewBox the SVG renders as 0×0. The fix adds
    // viewBox="0 0 640 360" so the placeholder fills the figure correctly.
    expect(BROGEDA_IT).toContain('viewBox=%220 0 640 360%22');
  });

  it('onerror swaps to an inline SVG (not hide)', () => {
    expect(BROGEDA_IT).toContain('this.onerror=null');
    expect(BROGEDA_IT).toContain('data:image/svg+xml');
    expect(BROGEDA_IT).not.toContain("style.display='none'");
  });
});

describe('F8 webcam — multi-locale regression', () => {
  const ALL_LOCALES = ['it', 'en', 'de', 'fr'] as const;

  for (const locale of ALL_LOCALES) {
    it(`[${locale}] chiasso-brogeda page has referrerpolicy="no-referrer"`, () => {
      const html = pages[buildOggiPath(locale, 'chiasso-brogeda')];
      expect(typeof html).toBe('string');
      if (html.includes('data-webcam-refresh')) {
        expect(html).toContain('referrerpolicy="no-referrer"');
      }
    });

    it(`[${locale}] chiasso-brogeda page figure has aspect-ratio:16/9`, () => {
      const html = pages[buildOggiPath(locale, 'chiasso-brogeda')];
      if (html.includes('<figure')) {
        expect(html).toMatch(/aspect-ratio:16\/9/);
      }
    });
  }
});
