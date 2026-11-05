import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  STADT_ZUERICH_KEY,
  STADT_ZUERICH_COMPANY_NAME,
  isStadtZuerichJob,
  isTrustedDomain,
} from '../scripts/lib/stadt-zuerich-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseOfficialAdPage,
  parseCurrentOfficialAdPage,
  parseCurrentOfficialJobLinks,
  fetchOfficialAdTexts,
  fetchAllStadtZuerichJobs,
} from '../scripts/lib/stadt-zuerich-job-parser.mjs';

const CURRENT_OFFICIAL_FIXTURE = `
  <main>
    <h1>Gärtner*in</h1>
    <p>Referenz-Nr.: 51726</p>
    <h2>Aufgaben</h2>
    <ul>
      <li>Sie pflegen und entwickeln öffentliche Grünanlagen fachgerecht.</li>
      <li>Sie planen die saisonalen Arbeiten und koordinieren die Einsätze.</li>
      <li>Sie beraten interne Stellen zu Pflanzen, Pflege und Biodiversität.</li>
    </ul>
    <h2>Profil</h2>
    <p>Sie verfügen über eine abgeschlossene Ausbildung im Gartenbau und
      arbeiten selbstständig, zuverlässig und gerne im Team.</p>
    <h2>Wir bieten</h2>
    <p>Wir bieten eine vielseitige Aufgabe, faire Anstellungsbedingungen,
      gute Sozialleistungen und zeitgemässe Arbeitsmittel.</p>
    <h2>Über uns</h2>
    <p>Grün Stadt Zürich gestaltet und pflegt die öffentlichen Freiräume
      der Stadt und arbeitet dabei eng mit der Bevölkerung zusammen.</p>
    <h2>Interessiert?</h2>
    <p>Kontaktperson und Telefonnummer stehen in diesem Abschnitt.</p>
  </main>
`;

describe('Stadt Zürich crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(STADT_ZUERICH_KEY).toBe('stadt-zuerich');
    expect(STADT_ZUERICH_COMPANY_NAME).toBe('Stadt Zürich');
  });

  // ── isCompanyJob ──
  describe('isStadtZuerichJob', () => {
    it('matches by companyKey', () => {
      expect(isStadtZuerichJob({ companyKey: 'stadt-zuerich' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isStadtZuerichJob({ company: 'Stadt Zürich' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(
        isStadtZuerichJob({ url: 'https://jobs.stadt-zuerich.ch/job/sachbearbeiter-in/12345/' })
      ).toBe(true);
    });

    it('rejects unrelated jobs (including Zurich Insurance Group)', () => {
      expect(
        isStadtZuerichJob({ companyKey: 'zurich', company: 'Zurich Insurance Group', url: 'https://www.zurich.com/careers' })
      ).toBe(false);
      expect(
        isStadtZuerichJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isStadtZuerichJob(null)).toBe(false);
      expect(isStadtZuerichJob(undefined)).toBe(false);
      expect(isStadtZuerichJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the jobs.stadt-zuerich.ch ATS host', () => {
      expect(isTrustedDomain('https://jobs.stadt-zuerich.ch/job/sachbearbeiter-in/12345/')).toBe(true);
    });

    it('trusts the stadt-zuerich.ch apex and subdomains', () => {
      expect(isTrustedDomain('https://www.stadt-zuerich.ch/')).toBe(true);
      expect(isTrustedDomain('https://stadt-zuerich.ch/')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
      expect(isTrustedDomain('https://www.zurich.com/careers')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Sachbearbeiter/-in Soziale Dienste, 80-100%');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('sachbearbeiter soziale dienste stadt zuerich')).toBe(
        'sachbearbeiter-soziale-dienste-stadt-zuerich'
      );
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'stadt-zuerich-abc123',
      slug: 'test-position-stadt-zuerich',
      slugByLocale: { de: 'test-position-stadt-zuerich' },
      company: 'Stadt Zürich',
      companyKey: 'stadt-zuerich',
      companyDomain: 'stadt-zuerich.ch',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      descriptionByLocale: {
        de: 'A test job description long enough to satisfy the fifty word minimum content guard used across every dedicated crawler in this repository, so the automated thin-content check passes cleanly during validation runs without any additional padding text required here at all today, even after accounting for whitespace splitting and word boundary edge cases across locales and punctuation marks throughout this fixture string.',
      },
      location: 'Zürich',
      canton: 'ZH',
      url: 'https://jobs.stadt-zuerich.ch/job/test-position/12345/',
      source: 'Stadt Zürich Dedicated Parser',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),

      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      streetAddress: 'Stadthausquai 17',
      postalCode: '8001',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().slice(0, 10),
      applyUrl: 'https://jobs.stadt-zuerich.ch/job/test-position/12345/',
    };

    it('has all required fields', () => {
      const required = [
        'id', 'slug', 'slugByLocale', 'company', 'companyKey',
        'title', 'titleByLocale', 'description', 'descriptionByLocale',
        'location', 'canton', 'url', 'source', 'sourceLang', 'crawledAt',
      ];
      for (const field of required) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('has the structured-data fields required by Non-Negotiable #3', () => {
      const structuredDataFields = [
        'postalCode', 'streetAddress', 'title', 'description',
        'postedDate', 'company', 'addressLocality', 'employmentType',
      ];
      for (const field of structuredDataFields) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('description is at least 50 words (Non-Negotiable #4 thin-content floor)', () => {
      const wordCount = validJob.description.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^stadt-zuerich-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

// Pinned fixture minimised from the city's official ad page
// www.stadt-zuerich.ch/…/jobs/job-detailseite.61759.html (2026-09-29). The
// jobs2web page only carries the title (even after client-side rendering), so
// every row was published as the tile summary: distinct postings with the same
// title and unit became identical (19/430 duplicate descriptions, audit run
// 36528331656), with no tasks, profile or offer at all.
describe('parseOfficialAdPage', () => {
  const fixture = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stadt-zuerich-official-ad-gaertner.html'),
    'utf8',
  );
  it('reads the Referenz-Nr. that joins the ad to its jobs2web tile', () => {
    expect(parseOfficialAdPage(fixture)?.ref).toBe('51726');
  });

  it('reads intro, Aufgaben, Profil, Wir bieten and Über uns with bullets', () => {
    const { description } = parseOfficialAdPage(fixture)!;
    const order = ['Sind Sie bereit', 'Aufgaben', 'Profil', 'Wir bieten', 'Über uns'].map((m) => description.indexOf(m));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(description).toMatch(/^• Sie führen selbständig anspruchsvolle Pflege- und Unterhaltsarbeiten/m);
  });

  it('leaves out the recruiter contact block', () => {
    const { description } = parseOfficialAdPage(fixture)!;
    expect(description).not.toContain('Interessiert?');
    expect(description).not.toMatch(/044 000 00 00|Vorname Nachname/);
  });

  it('returns null for a page without a reference or a body', () => {
    expect(parseOfficialAdPage('<html><body><stzh-richtext><p>x</p></stzh-richtext></body></html>')).toBeNull();
  });
});

// Only the posting's own text is published (issue 5253). A tile whose
// Referenz-Nr. has no official ad page used to go out as a synthetic tile
// summary ("{title} bei der Stadtverwaltung Zürich … Weitere Details … finden
// Sie auf der offiziellen Stellenplattform"); it is not published any more.
// If the legacy portal index is unavailable, the parser falls back to the
// hydrated current detail pages without inventing text for a tile whose body
// is still absent.
describe('fetchAllStadtZuerichJobs — tiles without an official ad', () => {
  const fixture = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stadt-zuerich-official-ad-gaertner.html'),
    'utf8',
  );
  const tile = (id: string, title: string, ref: string) => `<li class="job-tile job-id-${id} job-row" data-url="/job/${id}/${id}/">`
    + `<a class="jobTitle-link" href="/job/${id}/${id}/">${title}</a>`
    + `<div id="job-${id}-desktop-section-customfield1-value">Tiefbau- und Entsorgungsdepartement</div>`
    + `<div id="job-${id}-desktop-section-customfield2-value">Grün Stadt Zürich</div>`
    + `<div id="job-${id}-desktop-section-adcode-value">${ref}</div></li>`;
  const listing = `<ul>${tile('1101', 'Gärtner*in', '51726')}${tile('1102', 'Werkstattleiter*in', '99999')}</ul>`;
  const detailIdentity = (url: string, ref: string) => `<link rel="canonical" href="${url}"><div>Referenz-Nr.: ${ref}</div>`;
  const successFactorsDetail = (ref: string) => `<html lang="de"><head><title>Career Opportunities: Gärtner*in (${ref})</title></head><body><div class="joqReqDescription">${fixture}</div></body></html>`;

  function mockPortal({
    indexOk,
    directAdOk = false,
    directAdRefs = directAdOk ? ['51726'] : [],
    successFactorsRefs = [],
    listingHtml = listing,
    currentOfficialHtml = '',
  }: {
    indexOk: boolean;
    directAdOk?: boolean;
    directAdRefs?: string[];
    successFactorsRefs?: string[];
    listingHtml?: string;
    currentOfficialHtml?: string;
  }) {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.startsWith('https://jobs.stadt-zuerich.ch/search/')) return new Response(listingHtml, { status: 200 });
      if (u.includes('/stzh/jobsearch')) {
        return indexOk
          ? new Response(JSON.stringify({ results: [{ href: '/content/web/de/politik-und-verwaltung/arbeiten-bei-der-stadt/jobs/job-detailseite.61759.html' }] }), { status: 200 })
          : new Response('unavailable', { status: 503 });
      }
      if (u.startsWith('https://career2.successfactors.eu/career?')) {
        const ref = new URL(u).searchParams.get('career_job_req_id') || '';
        return successFactorsRefs.includes(ref)
          ? new Response(successFactorsDetail(ref), { status: 200 })
          : new Response('', { status: 404 });
      }
      if (u.includes('job-detailseite.61759.html')) return new Response(fixture, { status: 200 });
      const directRef = u.match(/job-detailseite\.(\d+)\.html$/)?.[1];
      if (directRef && directAdRefs.includes(directRef)) {
        return new Response(fixture.replace(/51726/g, directRef), { status: 200 });
      }
      if (u.includes('/jobs/de/gsz-51726.html')) {
        return new Response(currentOfficialHtml, { status: currentOfficialHtml ? 200 : 404 });
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes the tile with its official ad and skips the one without, never inventing text', async () => {
    mockPortal({ indexOk: true });
    const jobs = await fetchAllStadtZuerichJobs();
    expect(jobs.map((job) => job.title)).toEqual(['Gärtner*in']);
    expect(jobs[0].description).toContain('Aufgaben');
    for (const job of jobs) expect(job.description).not.toMatch(/bei der Stadtverwaltung Zürich/);
  }, 20_000);

  it('recovers through the current reference URL when the legacy official index is unavailable', async () => {
    mockPortal({ indexOk: false, directAdOk: true });
    // The second tile remains unresolved; keep this direct-reference test
    // isolated from the real browser-backed detail fallback.
    const jobs = await fetchAllStadtZuerichJobs({
      fetchCurrentDetailPage: async () => ({ html: '', descriptionHtml: '' }),
      fetchCurrentOfficialIndexPage: async () => '',
    });
    expect(jobs.map((job) => job.title)).toEqual(['Gärtner*in']);
    expect(jobs[0].description).toContain('Aufgaben');
  }, 20_000);

  it('recovers through the current SuccessFactors career detail when both legacy city sources are unavailable', async () => {
    const fetchMock = mockPortal({ indexOk: false, successFactorsRefs: ['51726'] });
    // Keep the unresolved second tile on the existing injected fallback path;
    // this focused test must not launch a real Playwright browser for it.
    const jobs = await fetchAllStadtZuerichJobs({
      fetchCurrentDetailPage: async () => ({ html: '', descriptionHtml: '' }),
      fetchCurrentOfficialIndexPage: async () => '',
    });

    expect(jobs.map((job) => job.referenceNumber)).toEqual(['51726']);
    expect(jobs[0].description).toContain('Aufgaben');
    const careerCalls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.startsWith('https://career2.successfactors.eu/career?'));
    expect(careerCalls).toHaveLength(2);
    expect(careerCalls[0]).toContain('company=STZH');
    expect(careerCalls[0]).toContain('career_ns=job_application');
    expect(careerCalls[0]).toContain('career_job_req_id=51726');
  }, 20_000);

  it('merges SuccessFactors and direct fallback bodies per reference', async () => {
    const partialListing = `<ul>${tile('1101', 'Gärtner*in', '51726')}${tile('1102', 'Werkstattleiter*in', '51727')}</ul>`;
    const fetchMock = mockPortal({
      indexOk: false,
      listingHtml: partialListing,
      successFactorsRefs: ['51726'],
      directAdRefs: ['51727'],
    });
    const jobs = await fetchAllStadtZuerichJobs({
      fetchCurrentOfficialIndexPage: async () => '',
    });

    expect(jobs.map((job) => job.referenceNumber)).toEqual(['51726', '51727']);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.description.includes('Aufgaben'))).toBe(true);
    const careerCalls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.startsWith('https://career2.successfactors.eu/career?'));
    expect(careerCalls).toHaveLength(2);
  }, 20_000);

  it('recovers from the migrated current official jobportal before using the jobs2web detail fallback', async () => {
    mockPortal({ indexOk: false, currentOfficialHtml: CURRENT_OFFICIAL_FIXTURE });
    const jobs = await fetchAllStadtZuerichJobs({
      fetchCurrentOfficialIndexPage: async () => '<a href="/jobs/de/gsz-51726.html">Gärtner*in</a>',
    });

    expect(jobs.map((job) => job.title)).toEqual(['Gärtner*in']);
    expect(jobs[0].description).toContain('Grün Stadt Zürich gestaltet');
    expect(jobs[0].description).not.toContain('Kontaktperson');
  }, 20_000);

  it('parses only current official detail links bound to requested references', () => {
    const links = parseCurrentOfficialJobLinks(`
      <a href="/jobs/de/gsz-51726.html">wanted</a>
      <a href="https://jobs.stadt-zuerich.ch/jobs/de/gsz-99999.html">wrong host</a>
      <a href="/jobs/de/gsz-12345.html">unwanted</a>
    `, new Set(['51726']));
    expect([...links]).toEqual([
      ['51726', 'https://www.stadt-zuerich.ch/jobs/de/gsz-51726.html'],
    ]);
  });

  it('parses the current official page template and excludes the contact section', () => {
    const parsed = parseCurrentOfficialAdPage(CURRENT_OFFICIAL_FIXTURE);
    expect(parsed?.ref).toBe('51726');
    expect(parsed?.description).toContain('Aufgaben');
    expect(parsed?.description).toContain('Über uns');
    expect(parsed?.description).not.toContain('Kontaktperson');
  });

  it('extracts the current reference from rendered text across inline markup', () => {
    const parsed = parseCurrentOfficialAdPage(`
      <main>
        <div><span>Referenz-Nr.</span><span>123456</span></div>
        <h2>Aufgaben</h2>
        <p>Teamarbeit</p>
      </main>
    `);

    expect(parsed?.ref).toBe('123456');
    expect(parsed?.description).toBeTruthy();
  });

  it('uses hydrated current detail pages when the official index cannot be read', async () => {
    mockPortal({ indexOk: false });
    const detailCalls: string[] = [];
    const jobs = await fetchAllStadtZuerichJobs({
      fetchCurrentDetailPage: async (url: string, row: { ref?: string }) => {
        detailCalls.push(url);
        return row.ref === '51726'
          ? { html: detailIdentity(url, String(row.ref)), descriptionHtml: fixture }
          : { html: '', descriptionHtml: '<p>Nur ein kurzer Eintrag.</p>' };
      },
      fetchCurrentOfficialIndexPage: async () => '',
    });

    expect(jobs.map((job) => job.title)).toEqual(['Gärtner*in']);
    expect(jobs[0].description).toContain('Aufgaben');
    expect(detailCalls).toEqual([
      'https://jobs.stadt-zuerich.ch/job/1101/1101/',
      'https://jobs.stadt-zuerich.ch/job/1102/1102/',
    ]);
  }, 20_000);

  it('does not attribute a hydrated body when the fetched detail identity is another posting', async () => {
    mockPortal({ indexOk: false });
    const jobs = await fetchAllStadtZuerichJobs({
      fetchCurrentDetailPage: async (url: string, row: { ref?: string }) => {
        if (row.ref === '51726') {
          return {
            html: detailIdentity('https://jobs.stadt-zuerich.ch/job/other/2202/', '99999'),
            descriptionHtml: fixture,
          };
        }
        return {
          html: detailIdentity(url, '99999'),
          descriptionHtml: fixture.replace(/51726/g, '99999'),
        };
      },
      fetchCurrentOfficialIndexPage: async () => '',
    });

    expect(jobs.map((job) => job.referenceNumber)).toEqual(['99999']);
  }, 20_000);

  it('fails the run when neither official source can be read', async () => {
    mockPortal({ indexOk: false });
    let caught: unknown;
    try {
      await fetchAllStadtZuerichJobs({
        fetchCurrentDetailPage: async () => ({
          html: '',
          descriptionHtml: '<p>Nur ein kurzer Eintrag.</p>',
        }),
        fetchCurrentOfficialIndexPage: async () => '',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('current job portal detail fallback yielded no vacancy text');
  }, 20_000);

  // 2026-09-29: the same ad re-posted under a second Referenz-Nr. (e.g.
  // Gastro-Allrounder*in 51367/51788, same service and official text) is one
  // vacancy; the tile with the lower job id is kept.
  it('publishes one page for an ad re-posted under a second Referenz-Nr.', async () => {
    const reposted = `<ul>${tile('1373317957', 'Gärtner*in', '51788')}${tile('1369892057', 'Gärtner*in', '51367')}</ul>`;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.startsWith('https://jobs.stadt-zuerich.ch/search/')) return new Response(reposted, { status: 200 });
      if (u.includes('/stzh/jobsearch')) {
        return new Response(JSON.stringify({ results: [
          { href: '/content/web/de/politik-und-verwaltung/arbeiten-bei-der-stadt/jobs/job-detailseite.62001.html' },
          { href: '/content/web/de/politik-und-verwaltung/arbeiten-bei-der-stadt/jobs/job-detailseite.62002.html' },
        ] }), { status: 200 });
      }
      if (u.includes('job-detailseite.62001.html')) return new Response(fixture.replace(/51726/g, '51788'), { status: 200 });
      if (u.includes('job-detailseite.62002.html')) return new Response(fixture.replace(/51726/g, '51367'), { status: 200 });
      return new Response('', { status: 404 });
    }));
    const jobs = await fetchAllStadtZuerichJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].referenceNumber).toBe('51367');
  }, 20_000);
});

describe('fetchOfficialAdTexts — partial legacy recovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('merges current official results for references absent from legacy results', async () => {
    const legacyAd = `
      <stzh-pagecontent>
        <stzh-richtext><p>Referenz-Nr.: 123</p><p>Legacy vacancy text</p></stzh-richtext>
      </stzh-pagecontent>
    `;
    const currentAd = `
      <main>
        <p>Referenz-Nr.: 456</p>
        <h2>Aufgaben</h2>
        <p>Current vacancy text</p>
      </main>
    `;
    const currentIndexRefs: string[][] = [];

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const value = String(url);
      if (value.includes('/stzh/jobsearch')) {
        return new Response(JSON.stringify({
          results: [{ href: '/content/web/de/politik-und-verwaltung/arbeiten-bei-der-stadt/jobs/job-detailseite.123.html' }],
        }), { status: 200 });
      }
      if (value.includes('job-detailseite.123.html')) return new Response(legacyAd, { status: 200 });
      if (value.includes('/jobs/de/unit-456.html')) return new Response(currentAd, { status: 200 });
      return new Response('', { status: 404 });
    }));

    const texts = await fetchOfficialAdTexts(
      new Set(['123', '456']),
      0,
      {
        fetchCurrentOfficialIndexPage: async (wantedRefs: string[]) => {
          currentIndexRefs.push(wantedRefs);
          return '<a href="/jobs/de/unit-456.html">Current vacancy</a>';
        },
      },
    );

    expect(texts.get('123')).toContain('Legacy vacancy text');
    expect(texts.get('456')).toContain('Current vacancy text');
    expect(currentIndexRefs).toEqual([['456']]);
  }, 20_000);
});
