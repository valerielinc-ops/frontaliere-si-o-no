import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EmployerInsightsReport } from '../components/pages/EmployerInsightsPage';
import { handleList, serializeEmployerInsightsTotals } from '../functions/src/adminEmployerInsights.js';

const employerPageSource = readFileSync(
  new URL('../components/pages/EmployerInsightsPage.tsx', import.meta.url),
  'utf8',
);
const employerTypeSource = readFileSync(
  new URL('../services/employerInsights.ts', import.meta.url),
  'utf8',
);
const adminPageSource = readFileSync(
  new URL('../components/pages/AdminPanel.tsx', import.meta.url),
  'utf8',
);
const adminApiSource = readFileSync(
  new URL('../functions/src/adminEmployerInsights.js', import.meta.url),
  'utf8',
);
const adminTypeSource = readFileSync(
  new URL('../services/adminInsights.ts', import.meta.url),
  'utf8',
);
const reportSource = readFileSync(
  new URL('../scripts/employer-traffic-report.mjs', import.meta.url),
  'utf8',
);
const writerSource = readFileSync(
  new URL('../scripts/write-employer-traffic.mjs', import.meta.url),
  'utf8',
);
const sequenceSource = readFileSync(
  new URL('../functions/src/coldEmailSequence.js', import.meta.url),
  'utf8',
);
const adminSendSource = readFileSync(
  new URL('../functions/src/adminSendColdEmail.js', import.meta.url),
  'utf8',
);

const window = {
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-09-09T00:00:00.000Z',
  timezone: 'UTC',
  kind: 'cumulative',
  inclusive: '[from,to)',
};

const basePayload = {
  schemaVersion: 2,
  companyKey: 'fixture',
  companyName: 'Fixture',
  generatedAt: '2026-09-09T00:00:00.000Z',
  source: 'events-source',
  window,
  applicationsCoverage: { source: 'applications-source' },
  provenance: { source: 'events-source', window },
  totals: {
    views: 111,
    visitors: 9,
    profileViews: 903,
    applyClicks: 701,
    applications: 302,
    adsCount: 1,
  },
  topAd: { slug: 'fixture', title: 'Fixture ad', views: 111 },
  ads: [{
    jobId: 'fixture-job',
    slug: 'fixture',
    title: 'Fixture ad',
    path: '/fixture/',
    views: 111,
    visitors: 9,
    applyClicks: 701,
    applications: 302,
    applicationsStatus: 'observed',
    eventsObserved: 812,
    eventTypes: { job_apply: 701, '$pageview': 111 },
    forwardedAt: null,
    delivery: 'non disponibile',
    trend: [],
  }],
  trend: [],
  profileTrend: [],
};

function render(data: unknown): string {
  return renderToStaticMarkup(
    React.createElement(EmployerInsightsReport, { data: data as never }),
  );
}

describe('employer insights payload UI', () => {
  it('keeps API zero observed distinct from missing or unscoped data', () => {
    expect(serializeEmployerInsightsTotals({ views: 0, applyClicks: 0 }, window)).toMatchObject({
      views: 0,
      applyClicks: 0,
    });
    expect(serializeEmployerInsightsTotals({ views: undefined, applyClicks: undefined }, window)).toMatchObject({
      views: null,
      applyClicks: null,
    });
    expect(serializeEmployerInsightsTotals({
      views: 99,
      visitors: 7,
      profileViews: 3,
      applyClicks: 31,
      applications: 2,
      applicationsStatus: 'observed',
      adsCount: 4,
    }, null)).toMatchObject({
      views: 99,
      visitors: 7,
      profileViews: 3,
      applyClicks: null,
      applications: null,
      applicationsStatus: null,
      adsObserved: 4,
    });
  });

  it('sorts legacy rows by stored views while keeping missing views after explicit zero', async () => {
    const row = (id: string, data: Record<string, unknown>) => ({ id, data: () => data });
    const emptyCollection = { get: async () => ({ docs: [], forEach: () => {} }) };
    const db = {
      collection(name: string) {
        if (name === 'employer_insights') {
          return {
            get: async () => ({
              docs: [
                row('zero', { companyName: 'Zero', totals: { views: 0, adsCount: 1 } }),
                row('missing', { companyName: 'Missing', totals: { adsCount: 1 } }),
                row('high', { companyName: 'High', totals: { views: 42, adsCount: 1 } }),
              ],
            }),
          };
        }
        return emptyCollection;
      },
    };

    const result = await handleList(db, 'test-secret');
    expect(result.body.insights.map((insight) => insight.companyKey)).toEqual(['high', 'zero', 'missing']);
  });

  it('renders a missing applyClicks value as unavailable, never as zero', () => {
    const html = render({
      ...basePayload,
      totals: { ...basePayload.totals, applyClicks: undefined },
    });

    expect(html).toContain('non disponibile');
    expect(html).toContain('dato assente');
    expect(html).not.toMatch(/Click per candidarsi[\s\S]{0,240}>0<|Click per candidarsi[\s\S]{0,240}>0<\/span>/);
  });

  it('has no consumer path that calculates or renders lost', () => {
    expect(render(basePayload)).not.toMatch(/lost|candidati lasciati sul tavolo|Persone interessate/i);
    const consumerSource = `${employerPageSource}\n${employerTypeSource}`;
    expect(consumerSource).not.toMatch(/\blost\b/i);
    expect(consumerSource).not.toMatch(/(?:views|profileViews)\s*-\s*(?:candidates|applyClicks)/i);
  });

  it('removes legacy employer candidate/lost fields from transport and admin surfaces', () => {
    expect(adminPageSource).not.toMatch(/\b(?:candidates|lost|conversionRate)\b/);
    expect(adminApiSource).not.toMatch(/\b(?:candidates|lost|conversionRate)\b/);
    expect(adminTypeSource).not.toMatch(/\b(?:candidates|lost|conversionRate)\b/);
    expect(reportSource).not.toMatch(/\bcandidates\s*:/);
    expect(writerSource).not.toMatch(/\bcandidates\s*:/);
    expect(sequenceSource).not.toMatch(/\bcandidates\b/);
    expect(adminSendSource).not.toMatch(/\b(?:candidates|lost)\b/);
    expect(adminPageSource).toContain('applyClicks');
    expect(adminPageSource).toContain('applications');
    expect(adminPageSource).toContain('profileViews');
  });

  it('renders applyClicks, applications and profileViews as separate annotated metrics', () => {
    const html = render(basePayload);

    expect(html).toContain('Click per candidarsi');
    expect(html).toContain('Candidature inviate');
    expect(html).toContain('Visualizzazioni profilo azienda');
    expect(html).toContain('>701<');
    expect(html).toContain('>302<');
    expect(html).toContain('>903<');
    expect(html).toContain('events-source');
    expect(html).toContain('applications-source');
    expect(html.match(/Finestra:/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html.match(/Sorgente:/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('2026-01-01T00:00:00.000Z');
    expect(html).toContain('2026-09-09T00:00:00.000Z');
    expect(html).toContain('UTC');
    expect(employerPageSource).not.toMatch(/['"](?:ga4|posthog)['"]/i);
  });

  it('keeps observed numbers when timezone is absent but the window is present', () => {
    const html = render({
      ...basePayload,
      window: { ...window, timezone: undefined },
    });

    expect(html).toContain('>701<');
    expect(html).toContain('dato osservato');
    expect(html).toContain('timezone non disponibile');
  });

  it('treats a payload source literally, even when it matches the UI fallback text', () => {
    const html = render({ ...basePayload, source: 'sorgente non disponibile' });

    expect(html).toContain('>701<');
    expect(html).toContain('sorgente non disponibile');
  });

  it('keeps zero observed, missing data and unavailable source distinct', () => {
    const zeroHtml = render({
      ...basePayload,
      totals: { ...basePayload.totals, applyClicks: 0 },
    });
    const sourceUnavailableHtml = render({
      ...basePayload,
      source: undefined,
      applicationsCoverage: undefined,
    });

    expect(zeroHtml).toContain('zero osservato');
    expect(sourceUnavailableHtml.match(/sorgente non disponibile/g)?.length).toBeGreaterThanOrEqual(4);
    expect(sourceUnavailableHtml).not.toMatch(/Click per candidarsi[\s\S]{0,240}>0<|Click per candidarsi[\s\S]{0,240}>701</);
  });
});
