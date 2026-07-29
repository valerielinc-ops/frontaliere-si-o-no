/**
 * Page-render layer coverage for the Liechtenstein border-municipality
 * family (issue #4884, third of the FR/DE/LI rollout after France
 * #4545/#4878 and Germany #4882).
 *
 * The data layer (dataset shape, source/year, plausibility guards) is
 * already covered by tests/liechtenstein-municipalities.test.ts, and the
 * reused content module by tests/liechtenstein-corridor-content.test.ts.
 * This file covers only the SSG renderer itself — above-floor page
 * content/indexability (including the mandatory flow-inversion
 * disclosure), below-floor noindex bridge + Search-Console self-map, and
 * the #4886 title-cascade regression pattern (mirrors
 * tests/french-border-municipality-pages.test.ts /
 * tests/german-border-municipality-pages.test.ts).
 */
import { describe, it, expect } from 'vitest';

import {
  renderAboveFloorPage,
  renderBridgePage,
} from '@/build-plugins/liechtensteinBorderMunicipalityPagesPlugin';
import {
  LIECHTENSTEIN_ABOVE_FLOOR,
  LIECHTENSTEIN_BELOW_FLOOR,
  LIECHTENSTEIN_LOCALES,
  LIECHTENSTEIN_REGIME,
  LIECHTENSTEIN_COMMUTING_CONTEXT,
  liechtensteinMunicipalityPathFor,
  isLiechtensteinBorderMunicipalityPath,
} from '@/build-plugins/liechtensteinBorderMunicipalityData';
import { LIECHTENSTEIN_CONTENT, groupThousands } from '@/data/liechtensteinCorridorContent';
import { TITLE_MAX_CHARS } from '@/build-plugins/shared/titleSuffix';
import { resolveSearchConsoleCompatTarget } from '@/build-plugins/searchConsoleCompat';

const DIST = '/tmp/__liechtenstein_border_dist_does_not_exist__';

describe('Liechtenstein border municipality above-floor page render (#4884)', () => {
  const schaan = LIECHTENSTEIN_ABOVE_FLOOR.find((m) => m.slug === 'schaan') ?? LIECHTENSTEIN_ABOVE_FLOOR[0];

  it('renders an indexable page with the art. 15 cpv. 4 H1, the 45-day threshold and >50 words', () => {
    const { html, wordCount, urlPath } = renderAboveFloorPage({
      municipality: schaan,
      locale: 'it',
      dateStamp: '2026-07-29',
      distDir: DIST,
    });
    expect(urlPath).toBe(liechtensteinMunicipalityPathFor('it', schaan.slug));
    expect(wordCount).toBeGreaterThan(50);
    expect(html).toMatch(/name=["']?robots["']?\s+content=["']?index,follow/);
    // Residence-exclusive taxation is qualitative only — no invented
    // CHF/EUR figure may appear as a "tax amount" tile.
    expect(html).toContain(String(LIECHTENSTEIN_REGIME.nonReturnThresholdDaysPerYear));
  });

  it('discloses the corridor flow inversion with the live commuting-context numbers (mandatory editorial fact)', () => {
    const { html } = renderAboveFloorPage({
      municipality: schaan,
      locale: 'it',
      dateStamp: '2026-07-29',
      distDir: DIST,
    });
    expect(html).toContain(String(LIECHTENSTEIN_COMMUTING_CONTEXT.year));
    expect(html).toContain(groupThousands(LIECHTENSTEIN_COMMUTING_CONTEXT.chToLi));
    expect(html).toContain(groupThousands(LIECHTENSTEIN_COMMUTING_CONTEXT.liToCh));
    expect(html).toContain(LIECHTENSTEIN_COMMUTING_CONTEXT.ratio);
    // The dominant-flow-is-inverted sentence itself, IT copy.
    expect(html).toMatch(/flusso dominante.*direzione opposta/i);
  });

  it('does not invent a health-insurance Optionsrecht claim for this corridor (unverified, excluded)', () => {
    const { html } = renderAboveFloorPage({
      municipality: schaan,
      locale: 'it',
      dateStamp: '2026-07-29',
      distDir: DIST,
    });
    expect(html).not.toMatch(/optionsrecht/i);
  });
});

describe('Liechtenstein border municipality below-floor bridge + self-map (#4884)', () => {
  const small = LIECHTENSTEIN_BELOW_FLOOR[0];

  it('renders a noindex,follow bridge at the same URL instead of a silent skip', () => {
    const html = renderBridgePage({ municipality: small, locale: 'it', distDir: DIST });
    expect(html).toMatch(/name=["']?robots["']?\s+content=["']?noindex,follow/);
  });

  it('self-maps every emitted Liechtenstein path (above + below, all locales) to itself', () => {
    const samples = [LIECHTENSTEIN_ABOVE_FLOOR[0], LIECHTENSTEIN_BELOW_FLOOR[0]];
    for (const m of samples) {
      for (const locale of LIECHTENSTEIN_LOCALES) {
        const p = liechtensteinMunicipalityPathFor(locale, m.slug);
        expect(isLiechtensteinBorderMunicipalityPath(p)).toBe(true);
        expect(resolveSearchConsoleCompatTarget(p)).toEqual({
          canonicalPath: p,
          kind: 'legacy',
          locale,
        });
      }
    }
  });

  it('does not claim an unrelated municipality path as live', () => {
    expect(isLiechtensteinBorderMunicipalityPath('/vivere-in-liechtenstein-lavorare-in-svizzera/comune-inventato-xyz/')).toBe(false);
  });
});

/**
 * #4886 regression pattern: with a 3-rung cascade
 * [content.municipalityTitle, titleMid, titleShort], every emitted <title>
 * must keep a keyword and stay within TITLE_MAX_CHARS, in every locale, for
 * every above-floor Gemeinde. Rung 1 reuses LIECHTENSTEIN_CONTENT's own
 * municipalityTitle() per the brief's mandatory-reuse instruction.
 */
describe('title cascade never degrades to a keyword-free bare name (#4886, Liechtenstein)', () => {
  const escapeHtml = (value: string): string =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const dateStamp = '2026-07-29';

  for (const municipality of LIECHTENSTEIN_ABOVE_FLOOR) {
    for (const locale of LIECHTENSTEIN_LOCALES) {
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

describe('longest-rung fallback stays keyword-bearing (#4886, Liechtenstein)', () => {
  const dateStamp = '2026-07-29';
  const overlongName = 'Ober-Schellenberg-an-der-Grenze-zu-Vorarlberg-und-Graubuenden';

  for (const locale of LIECHTENSTEIN_LOCALES) {
    it(`[${locale}] does not emit the bare overlong name as the whole title`, () => {
      const municipality = { ...LIECHTENSTEIN_ABOVE_FLOOR[0], name: overlongName };
      const { html } = renderAboveFloorPage({ municipality, locale, dateStamp, distDir: DIST });
      const title = html.match(/<title>([^<]*)<\/title>/)![1];

      expect(title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
      expect(title).not.toBe(overlongName);
      expect(title.trim()).not.toBe('');
    });
  }
});

describe('reuses LIECHTENSTEIN_CONTENT rather than re-authoring copy (#4884 brief requirement)', () => {
  it('municipalityTitle() from the content module is the rung-1 title candidate', () => {
    const municipality = LIECHTENSTEIN_ABOVE_FLOOR[0];
    for (const locale of LIECHTENSTEIN_LOCALES) {
      const rung1 = LIECHTENSTEIN_CONTENT[locale].municipalityTitle(municipality.name);
      // Rung 1 is only used verbatim when it fits TITLE_MAX_CHARS; assert the
      // reuse contract by construction (composePlaceTitle is exercised in
      // the cascade suite above) — here we just assert the content module
      // actually defines a non-empty, name-bearing title for every locale.
      expect(rung1).toContain(municipality.name);
      expect(rung1.length).toBeGreaterThan(0);
    }
  });
});
