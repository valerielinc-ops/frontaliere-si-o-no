import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { fetchGa4ErrorFallback } from '../scripts/posthog-error-issue-sync.mjs';
import { fetchGa4CwvFallback, ga4CwvSnapshot } from '../scripts/cwv-monitor-check.mjs';
import { fetchGa4ClsFallback } from '../scripts/revenue-monitor.mjs';
import { ga4DateRange } from '../scripts/lib/ga4-service-account.mjs';

const response = (json: unknown) => ({
  ok: true,
  status: 200,
  json: async () => json,
  text: async () => '',
});

describe('fallback GA4 dei monitor PostHog', () => {
  it('provisiona le dimensioni web_vitals prima di interrogarle', () => {
    const analyticsReport = readFileSync(resolve(import.meta.dirname, '../scripts/analytics-report.mjs'), 'utf8');
    for (const parameter of ['metric_name', 'metric_value', 'metric_rating']) {
      expect(analyticsReport, parameter).toContain(`parameterName: '${parameter}'`);
    }
  });

  it('usa una finestra assestata di esattamente N giornate', () => {
    expect(ga4DateRange(7, 2, new Date('2026-09-08T12:00:00Z'))).toEqual({
      startDate: '2026-08-31',
      endDate: '2026-09-06',
    });
  });

  it('rende verificabile il percorso auth di ogni consumer migrato', () => {
    const root = resolve(import.meta.dirname, '..');
    const migrated = [
      'scripts/posthog-error-issue-sync.mjs',
      'scripts/cwv-monitor-check.mjs',
      'scripts/profession-keyword-opportunities.mjs',
      'scripts/revenue-monitor.mjs',
      'scripts/build-evidence-index.mjs',
      'scripts/fetch-article-performance.mjs',
      'scripts/fetch-thin-page-promotions.mjs',
      'scripts/refresh-noslash-keep.mjs',
    ];
    for (const file of migrated) {
      expect(readFileSync(resolve(root, file), 'utf8'), file).toMatch(/getServiceAccountToken\(/);
    }
  });

  it('mantiene la firma degli errori e usa totalUsers come distinti', async () => {
    const fetchImpl = vi.fn(async () => response({
      rows: [{
        dimensionValues: [{ value: 'TypeError' }, { value: 'Boom' }, { value: '/pagina/' }],
        metricValues: [{ value: '12' }, { value: '7' }],
      }],
    }));

    const rows = await fetchGa4ErrorFallback({
      windowDays: 7,
      getTokenImpl: async () => 'ga4-token',
      fetchImpl,
    });

    expect(rows).toEqual([expect.objectContaining({
      type: 'TypeError', message: 'Boom', count: 12, sessions: 7,
    })]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ricostruisce il p75 CWV dalle osservazioni GA4 pesate', async () => {
    const fetchImpl = vi.fn(async () => response({
      rows: [
        { dimensionValues: [{ value: '/pagina/' }, { value: 'CLS' }, { value: '100' }, { value: 'mobile' }], metricValues: [{ value: '3' }] },
        { dimensionValues: [{ value: '/pagina/' }, { value: 'CLS' }, { value: '500' }, { value: 'mobile' }], metricValues: [{ value: '1' }] },
        { dimensionValues: [{ value: '/pagina/' }, { value: 'INP' }, { value: '300' }, { value: 'desktop' }], metricValues: [{ value: '4' }] },
      ],
    }));

    const rows = await fetchGa4CwvFallback({
      windowDays: 7,
      getTokenImpl: async () => 'ga4-token',
      fetchImpl,
    });

    expect(ga4CwvSnapshot(rows, '/pagina/')).toEqual({
      cls_p75: 0.1,
      cls_n: 4,
      inp_p75: 300,
      inp_n: 4,
    });
    const request = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(request.dimensions).toEqual([
      { name: 'pagePath' },
      { name: 'customEvent:metric_name' },
      { name: 'customEvent:metric_value' },
      { name: 'deviceCategory' },
    ]);
  });

  it('mantiene separati mobile e desktop nel fallback revenue', async () => {
    const fetchImpl = vi.fn(async () => response({
      rows: [
        { dimensionValues: [{ value: '/' }, { value: 'CLS' }, { value: '100' }, { value: 'mobile' }], metricValues: [{ value: '4' }] },
        { dimensionValues: [{ value: '/' }, { value: 'CLS' }, { value: '300' }, { value: 'desktop' }], metricValues: [{ value: '4' }] },
      ],
    }));

    const result = await fetchGa4ClsFallback({
      windowDays: 7,
      getTokenImpl: async () => 'ga4-token',
      fetchImpl,
    });

    expect(result).toMatchObject({ clsP75Mobile: 0.1, clsP75Desktop: 0.3, source: 'ga4-fallback' });
  });
});
