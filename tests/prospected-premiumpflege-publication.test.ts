import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';

const fixture = vi.hoisted(() => ({ datePosted: undefined as string | undefined, fetched: 0 }));
const applicationUrl = 'https://premiumpflege24.ch/job-registrierung/';
vi.mock('../scripts/lib/prospector/spec-crawler.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/lib/prospector/spec-crawler.mjs')>();
  return {
    ...actual,
    loadSpec: () => ({ companyKey: 'premiumpflege24', companyName: 'PremiumPflege24',
      companyHost: 'premiumpflege24.ch', seedUrls: ['https://premiumpflege24.ch/job-registrierung/'] }),
    // Exercise the real source-specific recovery used after an empty spec result.
    runSpecInProduction: async () => [],
    createSpecUrlPolicy: (spec: Parameters<typeof actual.createSpecUrlPolicy>[0]) => actual.createSpecUrlPolicy(spec, {
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    }),
    fetchRuntimePage: (url: string, policy: Parameters<typeof actual.fetchRuntimePage>[1]) => actual.fetchRuntimePage(url, policy, {
      sleepImpl: async () => {}, retries: 0,
      fetchImpl: async (input: string | URL | Request) => {
        const requestUrl = String(input);
        if (requestUrl.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
        if (requestUrl !== 'https://premiumpflege24.ch/job-registrierung/') throw new Error(`Unexpected URL: ${requestUrl}`);
        fixture.fetched++;
        const posting = { '@context': 'https://schema.org', '@type': 'JobPosting',
          title: 'Jobs in der Seniorenbetreuung', description: 'Betreuungskräfte gesucht.',
          jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressCountry: 'CH' } },
          ...(fixture.datePosted === undefined ? {} : { datePosted: fixture.datePosted }),
        };
        return new Response(`<html><head><title>Jobs in der Seniorenbetreuung</title>
          <script type="application/ld+json">${JSON.stringify(posting)}</script></head><body><main>
          <h1>Jobs in der Seniorenbetreuung</h1><p>Jobs in der ganzen Schweiz: Wir suchen engagierte Betreuungskräfte
          für die Seniorenbetreuung und Haushaltshilfe bei Menschen, die Unterstützung im Alltag benötigen.
          Die Einsätze können als Betreuung, stundenweise Begleitung oder Ferienbegleitung organisiert werden.
          Wir bieten faire Bedingungen, eine herzliche Teamkultur und sinnvolle Aufgaben mit direktem Kontakt
          zu unseren Kundinnen und Kunden. Ihre Bewerbung ist willkommen. Bewerben Sie sich über das Formular
          und teilen Sie uns Ihre Erfahrung, Ihre gewünschte Einsatzart und Ihre Verfügbarkeit mit.
          Unser Team begleitet den Bewerbungsprozess persönlich und klärt gemeinsam mit Ihnen den passenden Einsatz.</p>
          </main></body></html>`, { headers: { 'content-type': 'text/html' } });
      },
    }),
  };
});
import { fetchAllPremiumpflege24Jobs } from '../scripts/lib/premiumpflege24-job-parser.mjs';

beforeEach(() => {
  clearPoliteFetchStateForTests(); fixture.fetched = 0;
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('PremiumPflege24 real nationwide fallback publication evidence', () => {
  it.each([
    ['reported', '2026-10-01T09:30:00+02:00', '2026-10-01T09:30:00+02:00'],
    ['missing', undefined, ''],
    ['future', '2099-10-01', ''],
  ] as const)('%s preserves the application page without manufacturing a date', async (_case, date, expected) => {
    fixture.datePosted = date;
    const jobs = await fetchAllPremiumpflege24Jobs();
    expect(fixture.fetched).toBe(1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ postedDate: expected, datePosted: expected,
      postingDateSource: expected ? 'reported' : 'unknown',
      location: 'Schweiz', url: applicationUrl, applyUrl: applicationUrl,
      crawledAt: '2026-10-04T12:00:00.000Z' });
    expect(jobs[0].description).toContain('Ihre Bewerbung ist willkommen');
    expect(jobs[0].id).toBeTruthy();
  });
});
