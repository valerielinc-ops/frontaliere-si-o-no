/**
 * Page-render layer coverage for the Austria border-municipality family
 * (issue #4883, fourth of the FR/DE/AT/LI rollout after France #4545/#4878,
 * Germany #4882, Liechtenstein #4884/#3890).
 *
 * The data layer (dataset shape, source/year, floor rationale) is already
 * covered exhaustively by tests/austrian-border-municipalities-dataset.test.ts.
 * This file covers what that suite does not: the SSG renderer itself —
 * above-floor page content/indexability, below-floor noindex bridge +
 * Search-Console self-map, the #4886 title-cascade regression pattern
 * (mirrors tests/german-border-municipality-pages.test.ts), AND the
 * disinformation-prevention contract that is unique to this family: Austria
 * abrogated its special frontalieri regime in 2006/2007 (BGBl. III Nr.
 * 22/2007), so — unlike Germany's 4.5% cap / 60-day non-return threshold or
 * Liechtenstein's own thresholds — NO reduced rate, NO border-zone
 * restriction and NO non-return-days figure may ever appear on these pages.
 * A reader arriving from the German or Liechtenstein corridor pages must be
 * actively disabused of that expectation, not left to assume it carries
 * over.
 */
import { describe, it, expect } from 'vitest';

import {
  renderAboveFloorPage,
  renderBridgePage,
} from '@/build-plugins/austrianBorderMunicipalityPagesPlugin';
import {
  AUSTRIAN_ABOVE_FLOOR,
  AUSTRIAN_BELOW_FLOOR,
  AUSTRIAN_LOCALES,
  AUSTRIAN_REGIME,
  austrianMunicipalityPathFor,
  isAustrianBorderMunicipalityPath,
} from '@/build-plugins/austrianBorderMunicipalityData';
import { TITLE_MAX_CHARS } from '@/build-plugins/shared/titleSuffix';
import { resolveSearchConsoleCompatTarget } from '@/build-plugins/searchConsoleCompat';

const DIST = '/tmp/__austrian_border_dist_does_not_exist__';
const DATE_STAMP = '2026-07-29';

// Sourced regime figures (derived from AUSTRIAN_REGIME, never a second
// hard-coded literal) — these MUST appear, since they are the actual facts.
const COMP_RATE_STR = `${(AUSTRIAN_REGIME.interStateCompensationRate * 100).toFixed(1)}%`;
const TELEWORK_STR = `${(AUSTRIAN_REGIME.teleworkSocialSecurityThreshold * 100).toFixed(1)}%`;
const OECD_DAYS = String(AUSTRIAN_REGIME.oecdShortStayThresholdDays);

// The banned sibling-regime figures: Germany's 4.5% Quellensteuer cap and
// 60-day non-return threshold (in both Italian and German phrasing, since
// this dataset/test suite is authored primarily in Italian but the German
// locale page also exists). None of these may ever be emitted for Austria —
// the whole informational value of this page family is to DENY that a
// German-shaped figure applies here.
const BANNED_STRINGS = ['4,5%', '4.5%', '4,5 %', '60 giorni', '60 Arbeitstage', '60 Tage'];

// The unverified ~9,000 frontalieri estimate (mysalario.ch, no official
// anchor) must never be published.
const BANNED_WORKER_COUNT_STRINGS = ['9.000', "9'000", '9000', '9,000'];

describe('Austrian border municipality above-floor page render (#4883)', () => {
  const feldkirch = AUSTRIAN_ABOVE_FLOOR.find((m) => m.slug === 'feldkirch') ?? AUSTRIAN_ABOVE_FLOOR[0];

  it('renders an indexable page with >50 words and the sourced regime facts', () => {
    const { html, wordCount, urlPath } = renderAboveFloorPage({
      municipality: feldkirch,
      locale: 'it',
      dateStamp: DATE_STAMP,
      distDir: DIST,
    });
    expect(urlPath).toBe(austrianMunicipalityPathFor('it', feldkirch.slug));
    expect(wordCount).toBeGreaterThan(50);
    expect(html).toMatch(/name=["']?robots["']?\s+content=["']?index,follow/);
    // Credit method / inter-state compensation / OECD short-stay threshold /
    // telework social-security threshold must all be present.
    expect(html).toMatch(/Anrechnungsmethode/i);
    expect(html).toContain(COMP_RATE_STR);
    expect(html).toContain(OECD_DAYS);
    expect(html).toContain(TELEWORK_STR);
    expect(html).toMatch(/art\.\s*15/i);
    // The abrogation year must be present — it is the core fact this page
    // exists to communicate.
    expect(html).toContain(String(AUSTRIAN_REGIME.abrogatedEffectiveYear));
  });

  it('explicitly denies the German-corridor cap/threshold expectation without restating its figures', () => {
    const { html } = renderAboveFloorPage({
      municipality: feldkirch,
      locale: 'it',
      dateStamp: DATE_STAMP,
      distDir: DIST,
    });
    // Denial language referencing the neighbouring corridor by name.
    expect(html).toMatch(/german/i);
    expect(html).toMatch(/nessun(a)?\s+(tetto|riduzione)|no reduced|kein.*(satz|regime)|aucun(e)?\s+(taux|r[ée]gime)/i);
    // But never the actual German figures.
    for (const banned of BANNED_STRINGS) {
      expect(html).not.toContain(banned);
    }
  });

  it('never publishes the unverified ~9,000 frontalieri worker-count estimate', () => {
    const { html } = renderAboveFloorPage({
      municipality: feldkirch,
      locale: 'it',
      dateStamp: DATE_STAMP,
      distDir: DIST,
    });
    for (const banned of BANNED_WORKER_COUNT_STRINGS) {
      expect(html).not.toContain(banned);
    }
  });
});

describe('Austrian border municipality below-floor bridge + self-map (#4883)', () => {
  const small = AUSTRIAN_BELOW_FLOOR[0];

  it('renders a noindex,follow bridge at the same URL instead of a silent skip', () => {
    const html = renderBridgePage({ municipality: small, locale: 'it', distDir: DIST });
    expect(html).toMatch(/name=["']?robots["']?\s+content=["']?noindex,follow/);
  });

  it('bridge page also stays free of the banned sibling-regime figures', () => {
    const html = renderBridgePage({ municipality: small, locale: 'it', distDir: DIST });
    for (const banned of [...BANNED_STRINGS, ...BANNED_WORKER_COUNT_STRINGS]) {
      expect(html).not.toContain(banned);
    }
  });

  it('self-maps every emitted Austrian path (above + below, all locales) to itself', () => {
    const samples = [AUSTRIAN_ABOVE_FLOOR[0], AUSTRIAN_BELOW_FLOOR[0]];
    for (const m of samples) {
      for (const locale of AUSTRIAN_LOCALES) {
        const p = austrianMunicipalityPathFor(locale, m.slug);
        expect(isAustrianBorderMunicipalityPath(p)).toBe(true);
        expect(resolveSearchConsoleCompatTarget(p)).toEqual({
          canonicalPath: p,
          kind: 'legacy',
          locale,
        });
      }
    }
  });

  it('does not claim an unrelated municipality path as live', () => {
    expect(isAustrianBorderMunicipalityPath('/vivere-in-austria-lavorare-in-svizzera/citta-inventata-xyz/')).toBe(false);
  });
});

/**
 * Fiscal-exclusion contract across the ENTIRE above-floor dataset, all
 * locales — not just one sampled municipality. This is the strongest form
 * of the disinformation-prevention requirement: no rendered Austrian page,
 * in any language, may ever contain a German-corridor figure.
 */
describe('fiscal-exclusion contract holds across every above-floor comune and locale (#4883)', () => {
  for (const municipality of AUSTRIAN_ABOVE_FLOOR) {
    for (const locale of AUSTRIAN_LOCALES) {
      it(`${municipality.name} [${locale}] never emits a German-corridor figure or the unverified worker count`, () => {
        const { html } = renderAboveFloorPage({ municipality, locale, dateStamp: DATE_STAMP, distDir: DIST });
        for (const banned of [...BANNED_STRINGS, ...BANNED_WORKER_COUNT_STRINGS]) {
          expect(html).not.toContain(banned);
        }
      });
    }
  }
});

describe('fiscal-exclusion contract holds across every below-floor bridge and locale (#4883)', () => {
  for (const municipality of AUSTRIAN_BELOW_FLOOR) {
    for (const locale of AUSTRIAN_LOCALES) {
      it(`${municipality.name} [${locale}] bridge never emits a German-corridor figure or the unverified worker count`, () => {
        const html = renderBridgePage({ municipality, locale, distDir: DIST });
        for (const banned of [...BANNED_STRINGS, ...BANNED_WORKER_COUNT_STRINGS]) {
          expect(html).not.toContain(banned);
        }
      });
    }
  }
});

/**
 * #4886 regression pattern: with a 3-rung cascade [title, titleMid,
 * titleShort], every emitted <title> must keep a keyword and stay within
 * TITLE_MAX_CHARS, in every locale, for every above-floor Gemeinde.
 */
describe('title cascade never degrades to a keyword-free bare name (#4886, Austria)', () => {
  const escapeHtml = (value: string): string =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  for (const municipality of AUSTRIAN_ABOVE_FLOOR) {
    for (const locale of AUSTRIAN_LOCALES) {
      it(`${municipality.name} [${locale}] keeps a keyword and fits the escaped cap`, () => {
        const { html } = renderAboveFloorPage({ municipality, locale, dateStamp: DATE_STAMP, distDir: DIST });
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

describe('longest-rung fallback stays keyword-bearing (#4886, Austria)', () => {
  const overlongName = 'Sankt-Anton-am-Arlberg-im-hintersten-Klostertal-an-der-Grenze';

  for (const locale of AUSTRIAN_LOCALES) {
    it(`[${locale}] does not emit the bare overlong name as the whole title`, () => {
      const municipality = { ...AUSTRIAN_ABOVE_FLOOR[0], name: overlongName };
      const { html } = renderAboveFloorPage({ municipality, locale, dateStamp: DATE_STAMP, distDir: DIST });
      const title = html.match(/<title>([^<]*)<\/title>/)![1];

      expect(title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
      expect(title).not.toBe(overlongName);
      expect(title.trim()).not.toBe('');
    });
  }
});
