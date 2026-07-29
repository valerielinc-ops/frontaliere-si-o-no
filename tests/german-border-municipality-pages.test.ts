/**
 * Page-render layer coverage for the Germany border-municipality family
 * (issue #4882, second of the FR/DE/LI rollout after France #4545/#4878).
 *
 * The data layer (dataset shape, source/year, plausibility guards) is
 * already covered exhaustively by tests/german-border-municipalities-dataset.test.ts.
 * This file covers only what that suite does not: the SSG renderer itself —
 * above-floor page content/indexability, below-floor noindex bridge +
 * Search-Console self-map, and the #4886 title-cascade regression pattern
 * (mirrors tests/french-border-municipality-pages.test.ts /
 * tests/fiscal-municipality-pages.test.ts).
 */
import { describe, it, expect } from 'vitest';

import {
  renderAboveFloorPage,
  renderBridgePage,
} from '@/build-plugins/germanBorderMunicipalityPagesPlugin';
import {
  GERMAN_ABOVE_FLOOR,
  GERMAN_BELOW_FLOOR,
  GERMAN_LOCALES,
  GERMAN_REGIME_TAX,
  germanMunicipalityPathFor,
  isGermanBorderMunicipalityPath,
} from '@/build-plugins/germanBorderMunicipalityData';
import { TITLE_MAX_CHARS } from '@/build-plugins/shared/titleSuffix';
import { resolveSearchConsoleCompatTarget } from '@/build-plugins/searchConsoleCompat';

const DIST = '/tmp/__german_border_dist_does_not_exist__';
const TAX_RATE_STR = `${(GERMAN_REGIME_TAX.quellensteuerRate * 100).toFixed(1)}%`;

describe('German border municipality above-floor page render (#4882)', () => {
  const konstanz = GERMAN_ABOVE_FLOOR.find((m) => m.slug === 'konstanz') ?? GERMAN_ABOVE_FLOOR[0];

  it('renders an indexable page with the art. 15a H1, the sourced tax rate and >50 words', () => {
    const { html, wordCount, urlPath } = renderAboveFloorPage({
      municipality: konstanz,
      locale: 'it',
      dateStamp: '2026-07-29',
      distDir: DIST,
    });
    expect(urlPath).toBe(germanMunicipalityPathFor('it', konstanz.slug));
    expect(wordCount).toBeGreaterThan(50);
    expect(html).toMatch(/name=["']?robots["']?\s+content=["']?index,follow/);
    // The sourced 4.5% rate must appear, derived from GERMAN_REGIME_TAX
    // (never a second hard-coded literal — drift-safe).
    expect(html).toContain(TAX_RATE_STR);
    // The 60-day non-return threshold and the art. 15a regime marker.
    expect(html).toContain(String(GERMAN_REGIME_TAX.nonReturnThresholdDaysPerYear));
    expect(html).toContain('art. 15a');
    // Homeoffice-exemption fact must be present (explicit brief requirement).
    expect(html).toMatch(/telelavoro|homeoffice/i);
  });

  it('does not mention the Gre-2 form status or cite an Art. 24 sub-paragraph (unverified facts excluded)', () => {
    const { html } = renderAboveFloorPage({
      municipality: konstanz,
      locale: 'it',
      dateStamp: '2026-07-29',
      distDir: DIST,
    });
    expect(html).not.toMatch(/gre-2|gre2/i);
    expect(html).not.toMatch(/art(?:icolo)?\.?\s*24\s*(?:cpv|par|comma|lett)/i);
  });
});

describe('German border municipality below-floor bridge + self-map (#4882)', () => {
  const small = GERMAN_BELOW_FLOOR[0];

  it('renders a noindex,follow bridge at the same URL instead of a silent skip', () => {
    const html = renderBridgePage({ municipality: small, locale: 'it', distDir: DIST });
    expect(html).toMatch(/name=["']?robots["']?\s+content=["']?noindex,follow/);
  });

  it('self-maps every emitted German path (above + below, all locales) to itself', () => {
    const samples = [GERMAN_ABOVE_FLOOR[0], GERMAN_BELOW_FLOOR[0]];
    for (const m of samples) {
      for (const locale of GERMAN_LOCALES) {
        const p = germanMunicipalityPathFor(locale, m.slug);
        expect(isGermanBorderMunicipalityPath(p)).toBe(true);
        expect(resolveSearchConsoleCompatTarget(p)).toEqual({
          canonicalPath: p,
          kind: 'legacy',
          locale,
        });
      }
    }
  });

  it('does not claim an unrelated municipality path as live', () => {
    expect(isGermanBorderMunicipalityPath('/vivere-in-germania-lavorare-in-svizzera/citta-inventata-xyz/')).toBe(false);
  });
});

/**
 * #4886 regression pattern: with a 3-rung cascade [title, titleMid,
 * titleShort], every emitted <title> must keep a keyword and stay within
 * TITLE_MAX_CHARS, in every locale, for every above-floor Gemeinde — German
 * names run notably longer than the French dataset's (e.g. "Bonndorf im
 * Schwarzwald"), so this is the regime the cascade fix matters most for.
 */
describe('title cascade never degrades to a keyword-free bare name (#4886, Germany)', () => {
  const escapeHtml = (value: string): string =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const dateStamp = '2026-07-29';

  for (const municipality of GERMAN_ABOVE_FLOOR) {
    for (const locale of GERMAN_LOCALES) {
      it(`${municipality.name} [${locale}] keeps a keyword and fits the escaped cap`, () => {
        const { html } = renderAboveFloorPage({ municipality, locale, dateStamp, distDir: DIST });
        const match = html.match(/<title>([^<]*)<\/title>/);
        expect(match).not.toBeNull();

        const title = match![1];
        expect(title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
        expect(title).not.toBe(escapeHtml(municipality.name));
        expect(title).not.toContain('…');
        expect(title).toContain(escapeHtml(municipality.name));
      });
    }
  }
});

describe('longest-rung fallback stays keyword-bearing (#4886, Germany)', () => {
  const dateStamp = '2026-07-29';
  const overlongName = 'Sankt-Georgen-im-Schwarzwald-an-der-Grenze-zu-Baden-Wuerttemberg';

  for (const locale of GERMAN_LOCALES) {
    it(`[${locale}] does not emit the bare overlong name as the whole title`, () => {
      const municipality = { ...GERMAN_ABOVE_FLOOR[0], name: overlongName };
      const { html } = renderAboveFloorPage({ municipality, locale, dateStamp, distDir: DIST });
      const title = html.match(/<title>([^<]*)<\/title>/)![1];

      expect(title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
      expect(title).not.toBe(overlongName);
      expect(title.trim()).not.toBe('');
    });
  }
});
