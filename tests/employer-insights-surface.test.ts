import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  classifyCrawledTrafficState,
  normalizePublisherApplyClickDeduplication,
  summarizePublisherDashboardMetrics,
} from '../components/pages/PublisherDashboardPage';

const employerPage = readFileSync(
  new URL('../components/pages/EmployerInsightsPage.tsx', import.meta.url),
  'utf8',
);
const publisherPage = readFileSync(
  new URL('../components/pages/PublisherDashboardPage.tsx', import.meta.url),
  'utf8',
);
const adminPage = readFileSync(
  new URL('../components/pages/AdminPanel.tsx', import.meta.url),
  'utf8',
);

const localeFiles = [
  '../services/locales/it-core.ts',
  '../services/locales/en-core.ts',
  '../services/locales/de-core.ts',
  '../services/locales/fr-core.ts',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));

const WINDOW = {
  from: '2026-06-10T22:00:00.000Z',
  to: '2026-09-08T22:00:00.000Z',
};

const presentSnapshot = (id: string, data: Record<string, unknown> = {}) => ({
  id,
  exists: () => true,
  data: () => data,
});

const missingSnapshot = (id: string) => ({
  id,
  exists: () => false,
  data: () => ({}),
});

describe('employer insights surface semantics', () => {
  it('keeps overview tiles evenly inset from the card edges', () => {
    expect(employerPage).toContain('flex min-w-0 flex-col px-4 py-5 sm:px-5');
    expect(employerPage).not.toContain('first:pl-0');
    expect(employerPage).not.toContain('last:pr-0');
  });

  it('does not present proxy metrics as candidates, published ads, or lost applications', () => {
    expect(employerPage).toContain('Click per candidarsi');
    expect(employerPage).toContain('Candidature inviate');
    expect(employerPage).toContain('Un segnale di interesse, non una candidatura inviata.');

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

  it('does not aggregate admin rows from different analytics sources', () => {
    expect(adminPage).toContain('const firstSource = insightsRows[0]?.source || null;');
    expect(adminPage).toContain('insightsRows.every(r => r.source === firstSource)');
    expect(adminPage).toContain('source: commonSource');
  });
});

describe('publisher crawled traffic states', () => {
  it('does not hide the card behind a numeric greater-than-zero check', () => {
    expect(publisherPage).toContain("crawledTraffic.status === 'zero'");
    expect(publisherPage).toContain("crawledTraffic.status === 'data-missing'");
    expect(publisherPage).toContain("crawledTraffic.status === 'source-unavailable'");
    expect(publisherPage).not.toContain('crawledTraffic.candidates');
  });

  it('shows zero only when an explicit measured value is zero', () => {
    expect(classifyCrawledTrafficState({
      source: 'available',
      snapshots: [presentSnapshot('zero', { applyClicks: 0, source: 'ga4', window: WINDOW })],
    })).toEqual({ status: 'zero', metric: 'applyClicks', source: 'ga4', window: WINDOW });
  });

  it('does not turn an alias without a measured field into zero', () => {
    expect(classifyCrawledTrafficState({
      source: 'available',
      snapshots: [presentSnapshot('alias-without-metric', { source: 'ga4', window: WINDOW })],
    })).toEqual({ status: 'data-missing' });
  });

  it('shows missing data when the source responds without an alias record', () => {
    expect(classifyCrawledTrafficState({
      source: 'available',
      snapshots: [missingSnapshot('missing')],
    })).toEqual({
      status: 'data-missing',
    });
  });

  it('keeps the pre-migration candidates/clicks/windowDays schema visible as legacy data', () => {
    expect(classifyCrawledTrafficState({
      source: 'available',
      snapshots: [presentSnapshot('legacy', { candidates: 7, clicks: 3, windowDays: 30 })],
    })).toEqual({ status: 'legacy', candidates: 7, clicks: 3, windowDays: 30 });
    expect(publisherPage).toContain("crawledTraffic.status === 'legacy'");
    expect(publisherPage).toContain('Historical data is available in the previous format');
  });

  it('prefers current traffic records over stale legacy aliases', () => {
    expect(classifyCrawledTrafficState({
      source: 'available',
      snapshots: [
        presentSnapshot('legacy', { candidates: 7, clicks: 3, windowDays: 30 }),
        presentSnapshot('current', { applyClicks: 2, source: 'ga4', window: WINDOW }),
      ],
    })).toEqual({ status: 'available', value: 2, metric: 'applyClicks', source: 'ga4', window: WINDOW });
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
          presentSnapshot('empty', { source: 'ga4', window: WINDOW }),
          presentSnapshot('first', { applyClicks: 4, source: 'ga4', window: WINDOW }),
          presentSnapshot('second', { applyClicks: 2, source: 'ga4', window: WINDOW }),
        ],
      }),
    ).toEqual({ status: 'available', value: 6, metric: 'applyClicks', source: 'ga4', window: WINDOW });
  });

  it('uses the explicitly labelled proxy only when raw apply clicks are unavailable', () => {
    expect(classifyCrawledTrafficState({
      source: 'available',
      snapshots: [presentSnapshot('proxy', { applyClickProxy: 6, source: 'posthog', window: WINDOW })],
    })).toEqual({ status: 'available', value: 6, metric: 'interestSignals', source: 'posthog', window: WINDOW });
  });

  it('rejects a metric without source and explicit window', () => {
    expect(classifyCrawledTrafficState({
      source: 'available',
      snapshots: [presentSnapshot('unscoped', { applyClicks: 6 })],
    })).toEqual({ status: 'data-missing' });
  });
});

describe('publisher apply-click deduplication state', () => {
  it('does not present an overflow counter or rate as precise', () => {
    const deduplication = normalizePublisherApplyClickDeduplication({
      applyClicks: 64,
      applyClicksDeduplication: {
        strategy: 'emission_id_only',
        key: 'emission_id',
        status: 'dedup non disponibile',
        unavailableCount: 1,
      },
      applyClicksDedupUnavailable: 1,
    });
    const summary = summarizePublisherDashboardMetrics([
      {
        views: 100,
        applyClicks: 64,
        applyClicksDeduplication: deduplication,
      },
    ], 3);

    expect(summary).toEqual({
      views: 100,
      clicks: null,
      applications: 3,
      intentRate: null,
      applyClicksDeduplication: {
        status: 'dedup non disponibile',
        unavailableCount: 1,
      },
    });
    expect(publisherPage).toContain('applyClicksDeduplication');
    expect(publisherPage).toContain("status === 'dedup non disponibile'");
    expect(publisherPage).toContain("publisherDashboard.analytics.dedupUnavailable");
  });
});
