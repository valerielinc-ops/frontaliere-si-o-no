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
    expect(BROGEDA_IT).toMatch(/\breferrerpolicy=["']?no-referrer["']?/);
  });

  it('every webcam <img> on this page has referrerpolicy="no-referrer"', () => {
    // Extract all <img> tags and ensure each one has the attribute.
    const imgTags = [...BROGEDA_IT.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
    // There should be at least one webcam img
    const webcamImgs = imgTags.filter((tag) => tag.includes('data-webcam-refresh'));
    expect(webcamImgs.length).toBeGreaterThanOrEqual(1);
    for (const img of webcamImgs) {
      expect(img, `img missing referrerpolicy: ${img.slice(0, 100)}`).toMatch(
        /\breferrerpolicy=["']?no-referrer["']?/,
      );
    }
  });
});

/**
 * Class-extract migration (2026-05-20): inline styles in build-plugins were
 * extracted to content-hashed classes in public/assets/seo-static.css. The
 * webcam figure used to carry `style="...aspect-ratio:16/9;max-width:640px"`
 * directly; now it carries `class="s-<hash>"` whose CSS rule has the same
 * declarations. The helper below asserts the same SEMANTIC contract by
 * checking the inline form OR by following the s-* class reference into
 * the source CSS file.
 */
function htmlOrCssHas(html: string, declarations: ReadonlyArray<string>): boolean {
  const inlineHit = declarations.every((d) => html.includes(d));
  if (inlineHit) return true;
  const cssRules = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '..', '..', 'public', 'assets', 'seo-static.css'),
    'utf-8',
  );
  const classes = new Set(
    [...html.matchAll(/\bclass=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/g)]
      .flatMap((m) => (m[1] || m[2] || m[3] || '').split(/\s+/))
      .filter((c) => /^s-[A-Za-z0-9_-]+$/.test(c)),
  );
  for (const c of classes) {
    const rule = cssRules.match(new RegExp(`\\.${c}\\s*\\{([^}]*)\\}`));
    if (!rule) continue;
    if (declarations.every((d) => rule[1].includes(d))) return true;
  }
  return false;
}

describe('F8 webcam — responsive figure wrapper', () => {
  it('<figure> wrapper has aspect-ratio:16/9', () => {
    // The figure must constrain aspect ratio so the layout does not collapse
    // when the webcam image fails to load.
    expect(htmlOrCssHas(BROGEDA_IT, ['aspect-ratio:16/9'])).toBe(true);
  });

  it('<figure> wrapper has max-width:640px', () => {
    expect(htmlOrCssHas(BROGEDA_IT, ['max-width:640px'])).toBe(true);
  });

  it('<figure> wrapper has both aspect-ratio and max-width on the same element', () => {
    // Check that a single figure element has both constraints together (via
    // a single inline style OR via a single shared content-hashed class).
    const figureMatch = BROGEDA_IT.match(/<figure[^>]+>/);
    expect(figureMatch).not.toBeNull();
    const figureTag = figureMatch![0];
    expect(htmlOrCssHas(figureTag, ['aspect-ratio:16/9', 'max-width:640px'])).toBe(true);
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
        expect(html).toMatch(/\breferrerpolicy=["']?no-referrer["']?/);
      }
    });

    it(`[${locale}] chiasso-brogeda page figure has aspect-ratio:16/9`, () => {
      const html = pages[buildOggiPath(locale, 'chiasso-brogeda')];
      if (html.includes('<figure')) {
        expect(htmlOrCssHas(html, ['aspect-ratio:16/9'])).toBe(true);
      }
    });
  }
});
