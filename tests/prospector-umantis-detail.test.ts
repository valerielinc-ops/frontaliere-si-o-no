import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';
import { loadSpec, runSpecInProduction } from '../scripts/lib/prospector/spec-crawler.mjs';
import {
  extractUmantisDetailFields,
  extractUmantisListingEvidence,
  umantisDetailFallbackUrl,
} from '../scripts/lib/prospector/umantis-detail.mjs';
import { listingEvidenceFields } from '../scripts/lib/prospector/detail-extract.mjs';
import { resolveDetailOrListingSwissGeography } from '../scripts/lib/prospector/location-evidence.mjs';
import { fetchAllRecruitingapp2563Jobs } from '../scripts/lib/recruitingapp-2563-job-parser.mjs';

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

  it('reads SGKB postal locality from the newer Umantis column-value row', () => {
    const listing = `
      <table>
        <tr class="table-as-list__contentrow1">
          <td>
            <ul class="table-cell-content">
              <li><h3><a href="/Vacancies/3801/Description/1">Leiter*in Niederlassung Buchs 80 – 100%</a></h3></li>
              <li><span class="column-value" id="column_value_company">SGKB</span></li>
              <li><span class="column-value" id="column_value_location">9471 Buchs</span></li>
              <li><span class="column-value" id="column_value_type">Teilzeit</span></li>
            </ul>
          </td>
        </tr>
      </table>`;

    expect(extractUmantisListingEvidence(listing, 'https://recruitingapp-1154.umantis.com/Jobs/1').get('3801'))
      .toMatchObject({ location: 'Buchs', addressLocality: 'Buchs', postalCode: '9471' });
  });

  it('keeps both source-listed alternatives and projects a source-backed Swiss candidate', async () => {
    const title = 'Cloud Engineer Compute (80-100% - all identities and backgrounds*) in Zürich oder Lausanne';
    const seed = 'https://recruitingapp-2563.umantis.com/Jobs/1?lang=ger&ContentOnly=&message=';
    const listing = `<table><tbody><tr><td><ul class="table-cell-content">
      <li><h3><a href="/Vacancies/560/Description/1" aria-label="${title}">${title}</a></h3></li>
      <li class="form_content_paragraph"><span class="column-value">Switch</span></li>
    </ul></td></tr></tbody></table>`;
    const detail = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title,
      description: 'The generic structured employer address must not veto the title workplaces.'.repeat(12),
      jobLocation: { address: { addressLocality: 'Lugano', addressCountry: 'CH' } },
    })}</script></head><body><h1>${title}</h1><div class="customdatablock"><p>
      Du entwickelst und betreibst die Compute-Plattform der Schweizer Hochschulen. Dazu gehören
      Planung, Umsetzung und Betrieb skalierbarer Cloud-Services, Zusammenarbeit im Engineering-Team,
      Automatisierung mit Python sowie die Analyse und Behebung komplexer technischer Störungen.
      Du dokumentierst deine Lösungen und verbesserst gemeinsam mit dem Team die Zuverlässigkeit.
    </p></div></body></html>`;
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String((input as { url?: string })?.url ?? input);
      const pathname = new URL(url).pathname;
      if (pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /', { status: 200 });
      if (pathname === '/Jobs/1') return new Response(listing, { status: 200 });
      if (pathname === '/Vacancies/560/Description/1') return new Response(detail, { status: 200 });
      throw new Error(`unexpected URL ${url}`);
    });

    const evidence = extractUmantisListingEvidence(listing, seed).get('560');
    expect(evidence?.locationCandidates).toEqual([
      expect.objectContaining({ location: 'Zürich', addressLocality: 'Zürich', addressCountry: 'CH' }),
      expect.objectContaining({ location: 'Lausanne', addressLocality: 'Lausanne', addressCountry: 'CH' }),
    ]);
    expect(listingEvidenceFields({}, evidence)).toMatchObject({
      location: 'Zürich',
      addressLocality: 'Zürich',
      locationCandidates: evidence?.locationCandidates,
    });

    const jobs = await fetchAllRecruitingapp2563Jobs({
      fetchImpl,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      retries: 0,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title,
      location: 'Zürich',
      canton: 'ZH',
      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      addressCountry: 'CH',
    });
  });

  it('does not let a Swiss choice hide an unverified title alternative', () => {
    const mixed = `<table><tr><td><a href="/Vacancies/561/Description/1" aria-label="Engineer in Lausanne oder Berlin">
      Engineer in Lausanne oder Berlin</a></td></tr></table>`;
    expect(extractUmantisListingEvidence(mixed, 'https://recruitingapp-2563.umantis.com/Jobs/1').has('561'))
      .toBe(false);
  });

  it('does not let title alternatives override explicit foreign listing evidence', () => {
    const swissTitle = `<table><tr><td><a href="/Vacancies/562/Description/1" aria-label="Engineer in Lausanne oder Zürich">
      Engineer in Lausanne oder Zürich</a></td></tr></table>`;
    const titleEvidence = extractUmantisListingEvidence(
      swissTitle,
      'https://recruitingapp-2563.umantis.com/Jobs/1',
    ).get('562');
    const foreignListing = {
      location: 'Berlin',
      addressCountry: 'DE',
      locationCandidates: [{ location: 'Berlin', addressCountry: 'DE' }],
    };
    const folded = listingEvidenceFields(foreignListing, titleEvidence);

    expect(folded.locationCandidates).toEqual(foreignListing.locationCandidates);
    expect(resolveDetailOrListingSwissGeography({}, { ...foreignListing, ...folded }))
      .toMatchObject({ geography: null, explicitlyForeign: true });
  });

  it('keeps title alternatives when a listing row has only country-level evidence', () => {
    const title = 'Engineer in Zürich oder Lausanne';
    const listing = `<table><tr><td><a href="/Vacancies/563/Description/1" aria-label="${title}">
      ${title}</a></td></tr></table>`;
    const evidence = extractUmantisListingEvidence(
      listing,
      'https://recruitingapp-2563.umantis.com/Jobs/1',
    ).get('563');
    const folded = listingEvidenceFields({ addressCountry: 'CH' }, evidence);

    expect(folded).toMatchObject({
      location: 'Zürich',
      addressLocality: 'Zürich',
      addressCountry: 'CH',
      locationCandidates: [
        expect.objectContaining({ location: 'Zürich', addressLocality: 'Zürich' }),
        expect.objectContaining({ location: 'Lausanne', addressLocality: 'Lausanne' }),
      ],
    });
  });

  it('resolves only reviewed SGKB postcode/locality pairs and keeps the detail-drop gate', async () => {
    const spec = loadSpec('recruitingapp-1154');
    const seed = spec.seedUrls[0];
    const locations = [
      ['9011', '9102 Herisau', 'AR'],
      ['9012', '9450 Altstätten', 'SG'],
      ['9013', '9471 Buchs', 'SG'],
    ] as const;
    const listing = `<table>${locations.map(([id, value]) => `
      <tr><td><a href="/Vacancies/${id}/Description/1">Vacancy ${id}</a></td>
      <td><span class="column-value" id="column_value_location">${value}</span></td></tr>`).join('')}
    </table>`;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://recruitingapp-1154.umantis.com/robots.txt') {
        return response(url, 200, 'User-agent: *\nAllow: /');
      }
      if (url === seed) return response(url, 200, listing);
      if (/^https:\/\/recruitingapp-1154\.umantis\.com\/Vacancies\/\d+\/Description\/1$/.test(url)) {
        return response(url, 200, fixture('umantis-prospector-1154-detail.html'));
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const rows = await runSpecInProduction(spec, {
      fetchImpl,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      retries: 0,
    });

    expect(rows).toHaveLength(3);
    expect(rows.map(({ addressLocality, addressRegion, canton, postalCode }) => ({
      addressLocality, addressRegion, canton, postalCode,
    }))).toEqual([
      { addressLocality: 'Herisau', addressRegion: 'AR', canton: 'AR', postalCode: '9102' },
      { addressLocality: 'Altstätten', addressRegion: 'SG', canton: 'SG', postalCode: '9450' },
      { addressLocality: 'Buchs', addressRegion: 'SG', canton: 'SG', postalCode: '9471' },
    ]);

    const mismatched = extractUmantisListingEvidence(listing, seed, {
      cantonOverrides: spec.umantisListingCantonOverrides.map((entry: any) => ({
        ...entry,
        postalCode: '9999',
      })),
    });
    expect([...mismatched.values()].every((candidate) => !candidate.addressRegion)).toBe(true);

    const mismatchedLocality = extractUmantisListingEvidence(
      listing.replace('9102 Herisau', '9102 North Little Rock'),
      seed,
      { cantonOverrides: spec.umantisListingCantonOverrides },
    );
    expect(mismatchedLocality.get('9011')).toMatchObject({
      addressLocality: 'North Little Rock', postalCode: '9102', addressRegion: '',
    });
  });

  it('does not treat a postal/locality suffix in a generic metadata field as location evidence', () => {
    const base = 'https://jobs.example/';
    const make = (cell: string) => `<table><tr><td><a href="/Vacancies/1/Description/1">x</a></td>${cell}</tr></table>`;
    const sizes = [
      make('<span class="column-value">Recruiting 9000 St. Gallen</span>'),
      make('<li>Recruiting 9000 St. Gallen</li>'),
    ].map((html) => extractUmantisListingEvidence(html, base).size);

    expect(sizes).toEqual([0, 0]);
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
