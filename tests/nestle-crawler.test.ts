import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  NESTLE_KEY,
  NESTLE_COMPANY_NAME,
  isNestleJob,
  isTrustedDomain,
  fetchJobDescriptionText,
} from '../scripts/lib/nestle-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { detectSuccessFactorsKind } from '../scripts/lib/ats-clients/successfactors-client.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNestleDetailDescription, fetchAllNestleJobs } from '../scripts/lib/nestle-job-parser.mjs';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Nestlé crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(NESTLE_KEY).toBe('nestle');
    expect(NESTLE_COMPANY_NAME).toBe('Nestlé');
  });

  // ── isCompanyJob ──
  describe('isNestleJob', () => {
    it('matches by companyKey', () => {
      expect(isNestleJob({ companyKey: 'nestle' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isNestleJob({ company: 'Nestlé' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isNestleJob({ url: 'https://nestle.ch/jobs/123' })).toBe(true);
    });

    it('matches by current SuccessFactors URL domain', () => {
      expect(isNestleJob({ url: 'https://jobdetails.nestle.com/job/Orbe-Test/123/' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isNestleJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isNestleJob(null)).toBe(false);
      expect(isNestleJob(undefined)).toBe(false);
      expect(isNestleJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://nestle.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.nestle.ch/job/456')).toBe(true);
    });

    it('trusts current SuccessFactors job details host', () => {
      expect(isTrustedDomain('https://jobdetails.nestle.com/job/Orbe-Test/123/')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('SuccessFactors routing', () => {
    it('classifies Nestlé jobdetails search as a jobs2web SuccessFactors page', () => {
      expect(detectSuccessFactorsKind('https://jobdetails.nestle.com/search/?q=&locationsearch=Switzerland')).toBe('html-jobreq');
    });

    it('classifies Nestlé jobdetails detail pages as SuccessFactors pages', () => {
      expect(detectSuccessFactorsKind('https://jobdetails.nestle.com/job/Orbe-R%26D-Specialist/1377556533/')).toBe('html-jobreq');
    });
  });

  it('bounds a stalled detail request instead of consuming the crawler worker budget', async () => {
    const fetchMock = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchJobDescriptionText(
      'https://jobdetails.nestle.com/job/test/1/',
      { timeoutMs: 5 },
    )).resolves.toBe('');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer nestle ch')).toBe('developer-nestle-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'nestle-abc123',
      slug: 'test-position-nestle-ch',
      slugByLocale: { it: 'test-position-nestle-ch' },
      company: 'Nestlé',
      companyKey: 'nestle',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://nestle.ch/jobs/test',
      source: 'Nestlé Dedicated Parser',
      sourceLang: 'it',
      crawledAt: new Date().toISOString(),
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

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^nestle-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

// Pinned fixture: the description property block of jobdetails.nestle.com's
// Basel "Anlagenführer/in Abfüllung" page. Its body is full of nested
// `<span style=…>` headings; the former `<span class="jobdescription">(…?)</span>`
// regex stopped after "Positions Übersicht", fell under the 50-word floor and
// the parser published the synthetic "Key details" stub (40/108 rows,
// audit run 36528331656).
describe('parseNestleDetailDescription', () => {
  const fixture = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'nestle-sf-detail-anlagenfuehrer.html'),
    'utf8',
  );

  it('reads the whole vacancy body past the nested heading spans', () => {
    const text = parseNestleDetailDescription(fixture);
    expect(text).toContain('Positions Übersicht');
    expect(text).toContain('Ein Tag im Leben eines/-r Anlagenführer/in');
    expect(text).toContain('Das macht Sie erfolgreich');
    expect(text).toContain('Möchten auch Sie Teil der Thomy-Familie werden?');
    expect(text.split(/\s+/).length).toBeGreaterThan(300);
    expect(text).not.toContain('Key details');
  });

  it('keeps the lists as line-start bullets and does not cap the length', () => {
    const text = parseNestleDetailDescription(fixture);
    expect(text).toMatch(/^• Min\. 25 Tage Ferien pro Jahr/m);
    expect(text).toMatch(/^• Bereitschaft zu flexiblen Arbeitseinsätzen/m);
    expect(text.length).toBeGreaterThan(3000);
    expect(text).not.toMatch(/\r|\n{3,}| /);
  });

  it('returns empty for a page without the description block', () => {
    expect(parseNestleDetailDescription('<html><body><h1>x</h1></body></html>')).toBe('');
  });
});

// Only the posting's own text is published (issue 5253). A detail page
// without a vacancy body used to go out as the synthetic "Key details" stub;
// such a listing is not published any more. Search row shape from
// jobdetails.nestle.com (2026-09-29).
describe('fetchAllNestleJobs — listing without a vacancy body', () => {
  it('publishes the posting with a body and skips the one without, never inventing text', async () => {
    const fixture = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'nestle-sf-detail-anlagenfuehrer.html'),
      'utf8',
    );
    const row = (id: string, title: string) => `<tr class="data-row"><td class="colTitle"><a class="jobTitle-link" href="/job/Basel-${id}/${id}/">${title}</a></td><td class="colFacility"></td><td class="colLocation"><span class="jobLocation">Basel, CH</span></td><td class="colDate"><span class="jobDate">Sep 20, 2026</span></td></tr>`;
    const searchHtml = `<table>${row('1255000101', 'Anlagenführer/in Abfüllung')}${row('1255000102', 'Schichtleiter/in Produktion')}</table>`;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
      url.includes('/search/') ? searchHtml
        : url.includes('1255000101') ? fixture
          : '<html><body><span data-careersite-propertyid="description"><p>Jetzt bewerben</p></span></body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    )));
    try {
      const jobs = await fetchAllNestleJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].title).toBe('Anlagenführer/in Abfüllung');
      expect(jobs[0].description).toContain('Das macht Sie erfolgreich');
      for (const job of jobs) expect(job.description).not.toContain('Key details');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
