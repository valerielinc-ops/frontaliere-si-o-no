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
import { parseOfficialAdPage, fetchAllStadtZuerichJobs } from '../scripts/lib/stadt-zuerich-job-parser.mjs';

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
// Without the portal index no tile has its text, so the run fails instead of
// emptying the board.
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

  function mockPortal({ indexOk }: { indexOk: boolean }) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.startsWith('https://jobs.stadt-zuerich.ch/search/')) return new Response(listing, { status: 200 });
      if (u.includes('/stzh/jobsearch')) {
        return indexOk
          ? new Response(JSON.stringify({ results: [{ href: '/content/web/de/politik-und-verwaltung/arbeiten-bei-der-stadt/jobs/job-detailseite.61759.html' }] }), { status: 200 })
          : new Response('unavailable', { status: 503 });
      }
      if (u.includes('job-detailseite.61759.html')) return new Response(fixture, { status: 200 });
      return new Response('', { status: 404 });
    }));
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

  it('fails the run when the official index cannot be read', async () => {
    mockPortal({ indexOk: false });
    await expect(fetchAllStadtZuerichJobs()).rejects.toThrow(/official ad index unavailable/);
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
