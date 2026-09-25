import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';
import { runSpecInProduction } from '../scripts/lib/prospector/spec-crawler.mjs';
import {
  extractUmantisDetailFields,
  extractUmantisListingEvidence,
  umantisDetailFallbackUrl,
} from '../scripts/lib/prospector/umantis-detail.mjs';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

function response(url: string, status: number, body = '', location: string | null = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name: string) => name.toLowerCase() === 'location' ? location : null },
    body: { cancel: vi.fn() },
    text: async () => body,
  } as any;
}

type RuntimeCase = {
  key: string;
  host: string;
  vacancyId: string;
  title: string;
  detailFixture: string;
  seedFixture?: string;
  expectCount: number;
  redirectToDefault?: boolean;
  duplicateSeedLink?: boolean;
};

async function runCase(input: RuntimeCase) {
  const seed = `https://${input.host}/Jobs/1?lang=ger`;
  const detail = `https://${input.host}/Vacancies/${input.vacancyId}/Description/1`;
  const seedHtml = input.seedFixture
    ? fixture(input.seedFixture)
    : new Array(input.duplicateSeedLink ? 2 : 1)
      .fill(`<a href="/Vacancies/${input.vacancyId}/Description/1">${input.title}</a>`)
      .join('\n');
  const detailHtml = fixture(input.detailFixture);
  const requested: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    requested.push(url);
    if (url === `https://${input.host}/robots.txt`) return response(url, 200, 'User-agent: *\nAllow: /');
    if (url === seed) return response(url, 200, seedHtml);
    if (url === detail && input.redirectToDefault) return response(url, 302);
    if (url === detail || url === `${detail}/Default?`) return response(url, 200, detailHtml);
    throw new Error(`unexpected URL ${url}`);
  });
  const rows = await runSpecInProduction({
    companyKey: input.key,
    companyName: input.key,
    companyHost: input.host,
    platform: 'umantis.com',
    mode: 'template',
    seedUrls: [seed],
    detailTemplate: '/Vacancies/*/Description/1',
    detailFetchWorkers: 1,
    sourceLang: 'de',
  } as any, {
    fetchImpl,
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    sleepImpl: async () => {},
    retries: 0,
  });
  expect(rows).toHaveLength(input.expectCount);
  return { rows, requested, detail };
}

describe('Prospector Umantis detail boundary', () => {
  beforeEach(() => clearPoliteFetchStateForTests());

  it('extracts J. Safra content and Basel evidence without navigation chrome', () => {
    const detail = extractUmantisDetailFields(fixture('umantis-prospector-jsafrasarasin.html'));
    expect(detail.description).toContain('Your Role');
    expect(detail.description).toContain('• Several years of banking operations experience');
    expect(detail.description).not.toContain('Careers Locations Benefits Privacy');
    expect(detail.locationCandidates).toEqual([expect.objectContaining({
      location: 'Basel, CH', addressLocality: 'Basel', addressCountry: 'CH',
    })]);
  });

  it('extracts Austrian BIG content and location but runtime excludes it fail-closed', async () => {
    const detail = extractUmantisDetailFields(fixture('umantis-prospector-1123.html'));
    expect(detail.description).toContain('Deine Aufgaben');
    expect(detail.description).not.toContain('Startseite Immobilien Karriere Kontakt');
    expect(detail.locationCandidates[0]).toMatchObject({ location: 'Wien', addressLocality: 'Wien' });
    await runCase({
      key: 'recruitingapp-1123', host: 'recruitingapp-1123.umantis.com', vacancyId: '2497',
      title: 'Assistenz Immobilienverwaltung (m/w/d)', detailFixture: 'umantis-prospector-1123.html', expectCount: 0,
    });
  });

  it('uses SGKB row-scoped locality and same-origin /Default fallback without changing canonical URL', async () => {
    const listing = fixture('umantis-prospector-1154-listing.html');
    expect(extractUmantisListingEvidence(listing, 'https://recruitingapp-1154.umantis.com/Jobs/1').get('3799'))
      .toMatchObject({ location: 'St. Gallen', addressLocality: 'St. Gallen', postalCode: '9000' });
    const { rows, requested, detail } = await runCase({
      key: 'recruitingapp-1154', host: 'recruitingapp-1154.umantis.com', vacancyId: '3799',
      title: 'Strategischer Workforce Manager 80 – 100%', detailFixture: 'umantis-prospector-1154-detail.html',
      seedFixture: 'umantis-prospector-1154-listing.html', expectCount: 1, redirectToDefault: true,
    });
    expect(rows[0]).toMatchObject({ url: detail, location: 'St. Gallen', canton: 'SG', postalCode: '9000' });
    expect(rows[0].description).toContain('Das wirst du bewirken');
    expect(requested).toContain(`${detail}/Default?`);
    expect(umantisDetailFallbackUrl(detail)).toBe(`${detail}/Default?`);
  });

  it('extracts German Humboldt content and Arbeitsort but runtime excludes it fail-closed', async () => {
    const detail = extractUmantisDetailFields(fixture('umantis-prospector-2649.html'));
    expect(detail.description).toContain('Ihre Aufgaben');
    expect(detail.description).not.toContain('Stellenmarkt der Stiftung Navigation');
    expect(detail.locationCandidates[0]).toMatchObject({ location: 'Bonn', addressLocality: 'Bonn' });
    await runCase({
      key: 'recruitingapp-2649', host: 'recruitingapp-2649.umantis.com', vacancyId: '3705',
      title: 'Liegenschaftskoordinator (m/w/d)', detailFixture: 'umantis-prospector-2649.html', expectCount: 0,
    });
  });

  it('publishes only the Swiss LLB detail, preserving rich structure and URL identity', async () => {
    const detailFields = extractUmantisDetailFields(fixture('umantis-prospector-2677.html'));
    expect(detailFields.description).toContain('Ihre Rolle');
    expect(detailFields.description).not.toContain('Consent analytics');
    expect(detailFields.description).not.toContain('Vaduz Liechtenstein Datenschutz');
    expect(detailFields.locationCandidates[0]).toMatchObject({ location: 'Zürich', addressLocality: 'Zürich' });
    const { rows, detail } = await runCase({
      key: 'recruitingapp-2677', host: 'recruitingapp-2677.umantis.com', vacancyId: '1989',
      title: 'Spezialist:in Fondsadministration', detailFixture: 'umantis-prospector-2677.html',
      expectCount: 1,
    });
    expect(rows[0]).toMatchObject({ url: detail, location: 'Zürich', canton: 'ZH' });
    expect(rows[0].description.length).toBeGreaterThan(200);
  });

  it('deduplicates J. Safra links and keeps the canonical vacancy URL', async () => {
    const { rows, requested, detail } = await runCase({
      key: 'jsafrasarasin', host: 'jsafrasarasin.umantis.com', vacancyId: '508',
      title: 'Cash and Securities Reconciliation Specialist', detailFixture: 'umantis-prospector-jsafrasarasin.html',
      expectCount: 1, duplicateSeedLink: true,
    });
    expect(rows[0]).toMatchObject({ url: detail, location: 'Basel, CH', canton: 'BS' });
    expect(rows[0].description).toContain('• Several years of banking operations experience');
    expect(requested.filter((url) => url === detail)).toHaveLength(1);
  });
});
