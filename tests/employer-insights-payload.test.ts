import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EmployerInsightsReport, windowLabel } from '../components/pages/EmployerInsightsPage';
import type { Locale } from '../services/i18n';
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
  // The builder writes this block on every document. A payload without it
  // cannot claim its event counts are free of technical duplicates, so the
  // fixture carries the proof the real payload carries.
  coverage: { deduplication: { key: 'emission_id', status: 'available', unavailableCount: 0 } },
  provenance: { source: 'events-source', window },
  totals: {
    views: 111,
    visitors: 9,
    profileViews: 903,
    applyClicks: 701,
    applyClickUsers: 544,
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
    applyClickUsers: 544,
    applications: 302,
    applicationsStatus: 'observed',
    eventsObserved: 812,
    eventTypes: { job_apply: 701, '$pageview': 111 },
    forwardedAt: null,
    delivery: 'non disponibile',
    trend: [],
  }],
  trend: [
    { week: '2026-08-31', views: 71, visitors: 6, applyClicks: 480 },
    { week: '2026-09-07', views: 40, visitors: 3, applyClicks: 221 },
  ],
  profileTrend: [],
};

function render(data: unknown, locale?: Locale): string {
  return renderToStaticMarkup(
    React.createElement(EmployerInsightsReport, { data: data as never, locale }),
  );
}

describe('employer insights payload UI', () => {
  it('keeps API zero observed distinct from missing or unscoped data', () => {
    expect(serializeEmployerInsightsTotals({ views: 0, applyClicks: 0 }, window)).toMatchObject({
      views: 0,
      applyClicks: 0,
      applyClickUsers: null,
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
      applyClickUsers: 27,
      applications: 2,
      applicationsStatus: 'observed',
      adsCount: 4,
    }, null)).toMatchObject({
      views: 99,
      visitors: 7,
      profileViews: 3,
      applyClicks: null,
      applyClickUsers: null,
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

  it('renders source metrics and derived signals without exposing non-unique user units', () => {
    const html = render(basePayload);

    expect(html).toContain('Click per candidarsi');
    expect(html).toContain('Candidature inviate');
    expect(html).toContain('Visite al profilo azienda');
    expect(html).toContain('>701<');
    expect(html).not.toContain('>302<');
    expect(html).not.toContain('>903<');
    expect(html).toContain('Trasparenza della misura');
    expect(html).toContain('Peso dell’annuncio principale');
    expect(html).toContain('100,0%');
    expect(html).toContain('Annunci con click');
    expect(html).toContain('1 / 1');
    expect(html).not.toContain('Unità utente osservate');
    expect(html).not.toContain('>544<');
    expect(html).not.toContain('Visitatori osservati');
    expect(html).toContain('events-source');
    expect(html).toContain('Andamento nel tempo');
    expect(html).toContain('31 ago');
    expect(html).toContain('480 click per candidarsi');
    expect(html).not.toContain('Utenti associati ai click');
    expect(html).not.toContain('Finestra:');
    expect(html).not.toContain('Sorgente:');
    expect(html).not.toContain('2026-01-01T00:00:00.000Z');
    expect(html).not.toContain('2026-09-09T00:00:00.000Z');
    expect(html).not.toContain('UTC');
    expect(employerPageSource).not.toMatch(/['"](?:ga4|posthog)['"]/i);
    const ga4Html = render({ ...basePayload, source: 'ga4' });
    expect(ga4Html).toContain('Google Analytics');
    expect(ga4Html).not.toContain('>ga4<');
  });

  it('renders the report copy and number format for every supported locale', () => {
    const expected = {
      it: ['I segnali di Fixture', 'Click per candidarsi', 'Rivendica i tuoi annunci'],
      en: ['The signals from Fixture', 'Apply clicks', 'Claim your job ads'],
      de: ['Die Signale von Fixture', 'Klicks auf Bewerbung', 'Stellenanzeigen beanspruchen'],
      fr: ['Les signaux de Fixture', 'Clics pour postuler', 'Revendiquer vos offres'],
    } as const;
    for (const [locale, strings] of Object.entries(expected) as Array<[Locale, readonly string[]]>) {
      const html = render(basePayload, locale);
      for (const value of strings) expect(html).toContain(value);
    }
  });

  it('formats the API window as a friendly inclusive date range', () => {
    expect(windowLabel(window, 'it')).toBe('1 gen – 8 set 2026');
    expect(windowLabel(window, 'en')).toMatch(/Jan 1.*Sep 8.*2026/);
  });

  it('keeps observed numbers when timezone is absent but the window is present', () => {
    const html = render({
      ...basePayload,
      window: { ...window, timezone: undefined },
    });

    expect(html).toContain('>701<');
    expect(html).toContain('1 gen – 8 set 2026');
    expect(html).not.toContain('timezone non disponibile');
  });

  it('says a count is not proven unique when the payload carries no deduplication proof', () => {
    const { coverage, ...withoutProof } = basePayload;
    const html = render(withoutProof);

    // The measured traffic is kept — dropping it would delete real events...
    expect(html).toContain('>701<');
    // ...but it is not presented as a proven count of distinct acts.
    expect(html).toContain('unicità non provata');
    expect(html).toContain('La sorgente non dimostra che gli eventi siano azioni uniche');
    expect(html).not.toContain('conteggio osservato');
  });

  it('reports how many units could not be deduplicated', () => {
    const html = render({
      ...basePayload,
      coverage: { deduplication: { key: 'emission_id', status: 'dedup non disponibile', unavailableCount: 412 } },
    });

    expect(html).toContain('>701<');
    expect(html).toContain('unicità non provata');
    expect(html).toContain('eventi tecnici non hanno una prova di unicità');
    expect(html).toContain('412');
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
    expect(sourceUnavailableHtml).toContain('Fonte non disponibile');
    expect(sourceUnavailableHtml).not.toMatch(/Click per candidarsi[\s\S]{0,240}>0<|Click per candidarsi[\s\S]{0,240}>701</);
  });

  it('does not present negative observations as observed metrics', () => {
    const html = render({
      ...basePayload,
      totals: { ...basePayload.totals, views: -1 },
    });

    expect(html).toContain('Visualizzazioni annunci');
    expect(html).not.toContain('>-1<');
    expect(html).toContain('dato assente');
  });

  it('normalizes additional window keys and hides raw technical keys', () => {
    const summary = { window, totals: basePayload.totals, trend: [] };
    const html = render({
      ...basePayload,
      additionalWindows: {
        'all-time': summary,
        '90D': summary,
        P30D: summary,
        'unexpected-window': summary,
      },
    });

    expect(html).toContain('Ultimi 30 giorni');
    expect(html).toContain('Ultimi 90 giorni');
    expect(html).not.toContain('all-time');
    expect(html).not.toContain('90D');
    expect(html).not.toContain('P30D');
    expect(html).not.toContain('unexpected-window');
  });

  it('marks applications as partial when either coverage status is incomplete', () => {
    const payloads = [
      {
        ...basePayload,
        applicationsCoverage: { source: 'applications-source', status: 'partial' },
        totals: { ...basePayload.totals, applicationsStatus: 'observed' },
      },
      {
        ...basePayload,
        applicationsCoverage: { source: 'applications-source', status: 'observed' },
        totals: { ...basePayload.totals, applicationsStatus: 'partial' },
      },
    ];

    for (const payload of payloads) {
      const html = render(payload);
      expect(html).toContain('Candidature inviate');
      expect(html).toContain('copertura parziale');
      expect(html).not.toContain('>302<');
    }
  });
});
