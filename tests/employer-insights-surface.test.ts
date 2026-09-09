import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { classifyCrawledTrafficState } from '../components/pages/PublisherDashboardPage';

const employerPage = readFileSync(
  new URL('../components/pages/EmployerInsightsPage.tsx', import.meta.url),
  'utf8',
);
const publisherPage = readFileSync(
  new URL('../components/pages/PublisherDashboardPage.tsx', import.meta.url),
  'utf8',
);

const localeFiles = [
  '../services/locales/it-core.ts',
  '../services/locales/en-core.ts',
  '../services/locales/de-core.ts',
  '../services/locales/fr-core.ts',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));

const presentSnapshot = (id: string, candidates?: number) => ({
  id,
  exists: () => true,
  data: () => (candidates === undefined ? {} : { candidates }),
});

const missingSnapshot = (id: string) => ({
  id,
  exists: () => false,
  data: () => ({}),
});

describe('employer insights surface semantics', () => {
  it('does not present proxy metrics as candidates, published ads, or lost applications', () => {
    expect(employerPage).toContain('Click per candidarsi');
    expect(employerPage).toContain('Candidature inviate');
    expect(employerPage).toContain('Segnale di intento; non è un invio di candidatura.');

    expect(employerPage).not.toContain('candidati inviati');
    expect(employerPage).not.toContain('annunci pubblicati');
    expect(employerPage).not.toContain('candidati lasciati sul tavolo');
    expect(employerPage).not.toContain('totals.lost');
    expect(employerPage).not.toContain('diventa candidatura oggi');
    expect(employerPage).not.toContain('click in candidature dirette');
    expect(employerPage).not.toContain('candidature direttamente');
  });

  it('uses an intent or click label for the publisher rate in every core locale', () => {
    for (const locale of localeFiles) {
      expect(locale).toContain('publisherDashboard.kpi.intentRate');
      expect(locale).not.toContain('publisherDashboard.kpi.conversion');
      expect(locale).not.toMatch(/Tasso di conversione|Conversion rate|Konversionsrate|Taux de conversion/);
    }
  });
});

describe('publisher crawled traffic states', () => {
  it('does not hide the card behind a numeric greater-than-zero check', () => {
    expect(publisherPage).toContain("crawledTraffic.status === 'zero'");
    expect(publisherPage).toContain("crawledTraffic.status === 'data-missing'");
    expect(publisherPage).toContain("crawledTraffic.status === 'source-unavailable'");
  });

  it('shows zero when an alias record exists without a candidate record', () => {
    expect(classifyCrawledTrafficState({
      source: 'available',
      snapshots: [presentSnapshot('alias-without-candidates')],
    })).toEqual({ status: 'zero' });
  });

  it('shows missing data when the source responds without an alias record', () => {
    expect(classifyCrawledTrafficState({
      source: 'available',
      snapshots: [missingSnapshot('missing')],
    })).toEqual({
      status: 'data-missing',
    });
  });

  it('shows source unavailable only when the source read fails', () => {
    expect(classifyCrawledTrafficState({ source: 'unavailable' })).toEqual({
      status: 'source-unavailable',
    });
  });

  it('sums usable aliases while ignoring an empty alias record', () => {
    expect(
      classifyCrawledTrafficState({
        source: 'available',
        snapshots: [
          presentSnapshot('alias-without-candidates'),
          presentSnapshot('first', 4),
          presentSnapshot('second', 2),
        ],
      }),
    ).toEqual({ status: 'available', candidates: 6 });
  });
});
