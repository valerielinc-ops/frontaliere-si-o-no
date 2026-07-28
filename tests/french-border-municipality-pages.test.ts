/**
 * Regression coverage for issue #4886 (hardening follow-up of PR #4878).
 *
 * Item 1: `renderAboveFloorPage` in frenchBorderMunicipalityPagesPlugin.ts
 * builds its <title> via a 2-candidate cascade (`c.title(n)`, then the bare
 * name `n`), verified safe only against today's 22-commune dataset (longest
 * name 24 chars). This test proves the cascade's shared last-resort
 * fallback (`composePlaceTitle`'s truncateHeadline call) actually holds at
 * this call site for a commune name far longer than any in the live
 * dataset, not just at the generic unit level in compose-place-title.test.ts.
 *
 * Item 2: `buildDataset` in build-french-border-municipalities.mjs /
 * build-fiscal-municipalities.mjs now rejects an implausible distanceKm or
 * population via assertPlausibleMunicipality — a transcription typo in the
 * hand-maintained source .ts no longer silently misclassifies a commune's
 * floor tier or fiscal regime.
 */
import { describe, it, expect } from 'vitest';

import { renderAboveFloorPage } from '@/build-plugins/frenchBorderMunicipalityPagesPlugin';
import {
  FRENCH_ABOVE_FLOOR,
  FRENCH_LOCALES,
  type FrenchBorderMunicipality,
} from '@/build-plugins/frenchBorderMunicipalityData';
import { TITLE_MAX_CHARS } from '@/build-plugins/shared/titleSuffix';
import {
  assertPlausibleMunicipality,
  MIN_PLAUSIBLE_DISTANCE_KM,
  MAX_PLAUSIBLE_DISTANCE_KM,
  MIN_PLAUSIBLE_POPULATION,
  MAX_PLAUSIBLE_POPULATION,
} from '../scripts/lib/municipality-plausibility-guard.mjs';
import { buildDataset as buildFrenchDataset } from '../scripts/build-french-border-municipalities.mjs';
import { buildDataset as buildFiscalDataset } from '../scripts/build-fiscal-municipalities.mjs';

const DIST = '/tmp/__french_border_dist_does_not_exist__';

describe('French border municipality title cascade holds for an implausibly long commune name (#4886)', () => {
  const base = FRENCH_ABOVE_FLOOR[0];
  const longName = 'Saint-Jean-de-la-Vallée-du-Mont-Blanc-sur-Genevois-les-Deux-Rives';
  const longNameMunicipality: FrenchBorderMunicipality = { ...base, name: longName };

  it('keeps the emitted <title> within TITLE_MAX_CHARS even for a commune name far longer than any in the live dataset', () => {
    const { html } = renderAboveFloorPage({
      municipality: longNameMunicipality,
      locale: 'it',
      dateStamp: '2026-07-28',
      distDir: DIST,
    });
    const titleMatch = html.match(/<title>([^<]*)<\/title>/);
    expect(titleMatch).not.toBeNull();
    expect(titleMatch![1].length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  });
});

/**
 * The cap-only assertion above cannot fail: `composePlaceTitle` already
 * truncates the shortest candidate as a last resort, so the 66-char budget
 * always holds. The defect it was meant to catch is different — with a
 * 2-rung cascade `[c.title(n), n]`, a name that pushes the rich candidate
 * over budget degrades to the BARE COMMUNE NAME, which fits the cap but
 * carries no query intent at all (`<title>Hohentengen am Hochrhein</title>`).
 *
 * These tests assert the property that actually matters: every emitted title
 * keeps a keyword, in every locale, and never falls back to the naked name.
 * Length is measured AFTER HTML escaping, because that is the string that
 * ships and the string `audit:title-length` reads.
 */
describe('title cascade never degrades to a keyword-free bare name (#4886 Item 1)', () => {
  const escapeHtml = (value: string): string =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const dateStamp = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  for (const municipality of FRENCH_ABOVE_FLOOR) {
    for (const locale of FRENCH_LOCALES) {
      it(`${municipality.name} [${locale}] keeps a keyword and fits the escaped cap`, () => {
        const { html } = renderAboveFloorPage({ municipality, locale, dateStamp, distDir: DIST });
        const match = html.match(/<title>([^<]*)<\/title>/);
        expect(match).not.toBeNull();

        const title = match![1];
        expect(title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);

        // Never the naked commune name — that is the SEO-dead fallback.
        expect(title).not.toBe(escapeHtml(municipality.name));

        // Never a mid-headline ellipsis: the SERP policy in titleSuffix.ts
        // forbids it (CTR fell 4.8% -> 0.99% when it last shipped).
        expect(title).not.toContain('…');

        // The commune name must survive: it is the local-SEO token.
        expect(title).toContain(escapeHtml(municipality.name));
      });
    }
  }
});

/**
 * A name long enough to blow every rung must still degrade gracefully: the
 * shortest rung is keyword-bearing by construction, so even the truncated
 * result keeps the page's intent rather than collapsing to a naked toponym.
 */
describe('longest-rung fallback stays keyword-bearing (#4886 Item 1)', () => {
  const dateStamp = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const overlongName = 'Saint-Jean-de-la-Vallee-du-Mont-Blanc-sur-Genevois-les-Deux-Rives';

  for (const locale of FRENCH_LOCALES) {
    it(`[${locale}] does not emit the bare overlong name as the whole title`, () => {
      const municipality: FrenchBorderMunicipality = {
        ...FRENCH_ABOVE_FLOOR[0],
        name: overlongName,
      };
      const { html } = renderAboveFloorPage({ municipality, locale, dateStamp, distDir: DIST });
      const title = html.match(/<title>([^<]*)<\/title>/)![1];

      expect(title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
      expect(title).not.toBe(overlongName);
      expect(title.trim()).not.toBe('');
    });
  }
});

describe('municipality plausibility guard (#4886)', () => {
  it('throws on an out-of-range distanceKm', () => {
    expect(() =>
      assertPlausibleMunicipality(
        { name: 'Test', distanceKm: MAX_PLAUSIBLE_DISTANCE_KM + 1, population: 10000 },
        { sourceLabel: 'test' },
      ),
    ).toThrow(/implausible distanceKm/);
  });

  it('throws on an out-of-range population', () => {
    expect(() =>
      assertPlausibleMunicipality(
        { name: 'Test', distanceKm: 10, population: MAX_PLAUSIBLE_POPULATION + 1 },
        { sourceLabel: 'test' },
      ),
    ).toThrow(/implausible population/);
  });

  it('does not throw for values within the plausible range', () => {
    expect(() =>
      assertPlausibleMunicipality(
        { name: 'Test', distanceKm: MIN_PLAUSIBLE_DISTANCE_KM, population: MIN_PLAUSIBLE_POPULATION },
        { sourceLabel: 'test' },
      ),
    ).not.toThrow();
  });

  it('build-french-border-municipalities buildDataset rejects a transcribed-typo distanceKm', () => {
    const good = { ...FRENCH_ABOVE_FLOOR[0] };
    const typo = { ...good, distanceKm: good.distanceKm * 100 };
    expect(() => buildFrenchDataset([typo])).toThrow(/implausible distanceKm/);
    expect(() => buildFrenchDataset([good])).not.toThrow();
  });

  it('build-fiscal-municipalities buildDataset rejects a transcribed-typo population', () => {
    const good = {
      name: 'Comune Test',
      province: 'CO',
      lat: 45.8,
      lng: 9.08,
      irpefAddizionale: 0.006,
      distanceKm: 5,
      avgRentMonthly: 900,
      population: 10000,
      fascia: '20km',
    };
    const typo = { ...good, population: good.population * 1000 };
    expect(() => buildFiscalDataset([typo])).toThrow(/implausible population/);
    expect(() => buildFiscalDataset([good])).not.toThrow();
  });
});
