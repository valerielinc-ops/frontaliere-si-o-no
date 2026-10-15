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

describe('GA4 come sorgente dei monitor (fallback da #6948, primaria da H9)', () => {
  it('provisiona le dimensioni web_vitals prima di interrogarle', () => {
    const analyticsReport = readFileSync(resolve(import.meta.dirname, '../scripts/analytics-report.mjs'), 'utf8');
    for (const parameter of ['metric_name', 'metric_value', 'metric_rating']) {
      expect(analyticsReport, parameter).toContain(`parameterName: '${parameter}'`);
    }
  });

  it('non sporca lo stdout dei consumer JSON con la diagnostica auth', () => {
    const helper = readFileSync(resolve(import.meta.dirname, '../scripts/lib/ga4-service-account.mjs'), 'utf8');
    expect(helper).toContain('logInfo = console.error');
  });

  it('usa una finestra assestata di esattamente N giornate', () => {
    expect(ga4DateRange(7, 2, new Date('2026-09-08T12:00:00Z'))).toEqual({
      startDate: '2026-08-31',
      endDate: '2026-09-06',
    });
  });

  it('rende verificabile il percorso auth di ogni consumer migrato', () => {
    const root = resolve(import.meta.dirname, '..');
    // Decisione H9 (2026-10-05): GA4 non e' piu' il fallback di PostHog ma la
    // sorgente primaria. Questi monitor leggono GA4 col proprio token e
    // consultano la guardia GA4 prima di giudicare.
    const ga4Primary = [
      'scripts/posthog-error-issue-sync.mjs',
      'scripts/cwv-monitor-check.mjs',
      'scripts/profession-keyword-opportunities.mjs',
      'scripts/revenue-monitor.mjs',
    ];
    const independentGa4Mirror = [
      'scripts/build-evidence-index.mjs',
      'scripts/fetch-article-performance.mjs',
      'scripts/fetch-thin-page-promotions.mjs',
      'scripts/refresh-noslash-keep.mjs',
    ];
    const byConstruction = [
      'scripts/funnel-metrics-snapshot.mjs',
    ];
    for (const file of ga4Primary) {
      const source = readFileSync(resolve(root, file), 'utf8');
      expect(source, file).toMatch(/checkLivenessImpl\s*=\s*checkGa4Liveness/);
      expect(source, file).not.toMatch(/checkPostHogLiveness/);
      expect(source, file).toMatch(/getServiceAccountToken\(/);
    }
    for (const file of independentGa4Mirror) {
      expect(readFileSync(resolve(root, file), 'utf8'), file).toMatch(/getServiceAccountToken\(/);
    }
    for (const file of byConstruction) {
      expect(readFileSync(resolve(root, file), 'utf8'), file).not.toMatch(/getServiceAccountToken\(/);
    }
    // La guardia stessa interroga GA4 (token iniettabile, default il service account).
    const liveness = readFileSync(resolve(root, 'scripts/lib/source-liveness.mjs'), 'utf8');
    expect(liveness).toMatch(/export async function checkGa4Liveness/);
    expect(liveness).toMatch(/getTokenImpl = getServiceAccountToken/);
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

  it('rifiuta un p75 troncato in entrambi i consumer e limita CWV alle URL monitorate', async () => {
    const fetchImpl = vi.fn(async () => response({
      rowCount: 2,
      rows: [{ dimensionValues: [{ value: '/' }, { value: 'CLS' }, { value: '100' }, { value: 'mobile' }], metricValues: [{ value: '40' }] }],
    }));
    expect(await fetchGa4CwvFallback({ windowDays: 7, getTokenImpl: async () => 'test', fetchImpl })).toBeNull();
    const request = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(request.dimensionFilter.andGroup.expressions[1].filter).toMatchObject({
      fieldName: 'pagePath', inListFilter: { values: expect.arrayContaining(['/', '/cerca-lavoro-svizzera/']) },
    });
    expect(await fetchGa4ClsFallback({ windowDays: 7, getTokenImpl: async () => 'test', fetchImpl })).toBeNull();
  });

  it.each([
    { dataLossFromOtherRow: true },
    { samplingMetadatas: [{ samplesReadCount: '10', samplingSpaceSize: '100' }] },
    { dataTruncationReasons: [{ dataTruncationType: 'DATA_TRUNCATION_TYPE_DATE_RANGE' }] },
    { subjectToThresholding: true },
  ])('si astiene sui segnali metadata di distribuzione incompleta: %j', async (metadata) => {
    const fetchImpl = vi.fn(async () => response({ metadata, rowCount: 1,
      rows: [{ dimensionValues: [{ value: '/' }, { value: 'INP' }, { value: '100' }, { value: 'mobile' }], metricValues: [{ value: '40' }] }],
    }));
    expect(await fetchGa4CwvFallback({ windowDays: 7, getTokenImpl: async () => 'test', fetchImpl })).toBeNull();
    expect(await fetchGa4ClsFallback({ windowDays: 7, getTokenImpl: async () => 'test', fetchImpl })).toBeNull();
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

  it('si astiene quando GA4 aggrega una quota significativa in `(other)`', async () => {
    const fetchImpl = vi.fn(async () => response({
      rows: [
        { dimensionValues: [{ value: '/' }, { value: 'CLS' }, { value: '100' }, { value: 'mobile' }], metricValues: [{ value: '1' }] },
        { dimensionValues: [{ value: '(other)' }, { value: 'CLS' }, { value: '(other)' }, { value: 'mobile' }], metricValues: [{ value: '10' }] },
      ],
    }));

    const result = await fetchGa4ClsFallback({
      windowDays: 7,
      getTokenImpl: async () => 'ga4-token',
      fetchImpl,
    });

    expect(result).toBeNull();

    const cwvResult = await fetchGa4CwvFallback({
      windowDays: 7,
      getTokenImpl: async () => 'ga4-token',
      fetchImpl,
    });

    expect(cwvResult).toBeNull();
  });
});
