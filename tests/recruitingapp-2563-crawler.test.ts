import { describe, it, expect } from 'vitest';
import {
  fetchAllRecruitingapp2563Jobs,
  RECRUITINGAPP_2563_KEY,
  RECRUITINGAPP_2563_COMPANY_NAME,
  extractRecruitingapp2563Description,
  extractRecruitingapp2563DetailFields,
  extractRecruitingapp2563TitleLocation,
  isRecruitingapp2563Job,
  isTrustedDomain,
} from '../scripts/lib/recruitingapp-2563-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Switch Bewerbermanagement Stellen crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(RECRUITINGAPP_2563_KEY).toBe('recruitingapp-2563');
    expect(RECRUITINGAPP_2563_COMPANY_NAME).toBe('Switch Bewerbermanagement Stellen');
  });

  describe('title-backed workplace evidence', () => {
    it('extracts only vacancy prose from the current Switch custom template', () => {
      const body = 'Du betreibst und entwickelst sichere Cloud-Plattformen für Schweizer Hochschulen. '.repeat(12);
      const html = `
        <div class="content">
          <div class="text"><p>Generic employer introduction must stay outside the vacancy.</p></div>
          <h1>Cloud Engineer Compute in Zürich oder Lausanne</h1>
          <div class="s1">Dein Team und deine Arbeit</div>
          <p>${body}</p>
          <div id="mg_footer"><p>Contact and application chrome must stay outside.</p></div>
        </div>`;

      const description = extractRecruitingapp2563Description(html);
      expect(description).toContain('Du betreibst und entwickelst sichere Cloud-Plattformen');
      expect(description).not.toContain('Generic employer introduction');
      expect(description).not.toContain('Contact and application chrome');
      expect(extractRecruitingapp2563Description(html.replace('id="mg_footer"', 'id="changed_footer"')))
        .toBe('');
    });

    it('accepts a single Swiss city explicitly published in the title', () => {
      expect(extractRecruitingapp2563TitleLocation(
        'Chief Information Officer (80-100%) in Zürich',
      )).toEqual({
        location: 'Zürich',
        addressLocality: 'Zürich',
        addressCountry: 'CH',
      });
    });

    it('keeps multi-site and unrecognised title locations unknown', () => {
      expect(extractRecruitingapp2563TitleLocation(
        'Role in Zürich und in Lausanne',
      )).toBeNull();
      expect(extractRecruitingapp2563TitleLocation(
        'System Engineer (80-100%) in Zürich oder Lausanne',
      )).toBeNull();
      expect(extractRecruitingapp2563TitleLocation(
        'Network & Security Engineer (80-100%)',
      )).toBeNull();
    });

    it('prefers explicit title location over a generic employer address', () => {
      const title = 'Chief Information Officer (80-100%) in Zürich';
      const html = `
        <script type="application/ld+json">${JSON.stringify({
          '@type': 'JobPosting',
          title,
          description: 'Lead internal IT services and governance.'.repeat(30),
          jobLocation: { address: { addressLocality: 'Lugano', addressCountry: 'CH' } },
        })}</script>
        <h1>${title}</h1>
        <main>${'Aufgaben und Verantwortlichkeiten für diese Stelle. '.repeat(40)}</main>`;

      expect(extractRecruitingapp2563DetailFields(html, 'https://recruitingapp-2563.umantis.com/Vacancies/559/Description/1'))
        .toMatchObject({
          title,
          location: 'Zürich',
          addressCountry: 'CH',
          locationCandidates: [{
            location: 'Zürich',
            addressLocality: 'Zürich',
            addressCountry: 'CH',
          }],
        });
    });

    it('preserves explicit Swiss alternatives when the detail has a generic employer address', () => {
      const title = 'System Engineer (80-100%) in Zürich oder Lausanne';
      const html = `
        <script type="application/ld+json">${JSON.stringify({
          '@type': 'JobPosting',
          title,
          description: 'Design and operate secure network services.'.repeat(30),
          jobLocation: { address: { addressLocality: 'Lugano', addressCountry: 'CH' } },
        })}</script>
        <h1>${title}</h1>
        <main>${'Aufgaben und Verantwortlichkeiten für diese Stelle. '.repeat(40)}</main>`;

      expect(extractRecruitingapp2563DetailFields(html, 'https://recruitingapp-2563.umantis.com/Vacancies/560/Description/1'))
        .toMatchObject({
          title,
          location: 'Zürich',
          addressLocality: 'Zürich',
          locationCandidates: [
            { location: 'Zürich', addressLocality: 'Zürich', addressCountry: 'CH' },
            { location: 'Lausanne', addressLocality: 'Lausanne', addressCountry: 'CH' },
          ],
        });
    });

    it('keeps a foreign alternative fail-closed even with a Swiss employer address', () => {
      const title = 'System Engineer (80-100%) in Lausanne oder Berlin';
      const html = `
        <script type="application/ld+json">${JSON.stringify({
          '@type': 'JobPosting',
          title,
          description: 'Design and operate secure network services.'.repeat(30),
          jobLocation: { address: { addressLocality: 'Lugano', addressCountry: 'CH' } },
        })}</script>
        <h1>${title}</h1>
        <main>${'Aufgaben und Verantwortlichkeiten für diese Stelle. '.repeat(40)}</main>`;

      expect(extractRecruitingapp2563DetailFields(html, 'https://recruitingapp-2563.umantis.com/Vacancies/562/Description/1'))
        .toMatchObject({
          title,
          location: '',
          addressCountry: '',
          locationCandidates: [],
          locationGateRejected: true,
        });
    });

    it('rejects a title-backed location when structured and rendered titles disagree', () => {
      const structuredTitle = 'Role in Zürich';
      const renderedTitle = 'Role in Zürich und in Lausanne';
      const html = `
        <script type="application/ld+json">${JSON.stringify({
          '@type': 'JobPosting',
          title: structuredTitle,
          description: 'Design and operate secure network services.'.repeat(30),
          jobLocation: { address: { addressLocality: 'Lugano', addressCountry: 'CH' } },
        })}</script>
        <h1>${renderedTitle}</h1>
        <main>${'Aufgaben und Verantwortlichkeiten für diese Stelle. '.repeat(40)}</main>`;

      expect(extractRecruitingapp2563DetailFields(html, 'https://recruitingapp-2563.umantis.com/Vacancies/561/Description/1'))
        .toMatchObject({
          title: structuredTitle,
          location: '',
          addressCountry: '',
          locationCandidates: [],
          locationGateRejected: true,
        });
    });

    it('keeps a single title-backed listing publishable through the spec runtime', async () => {
      const seed = 'https://recruitingapp-2563.umantis.com/Jobs/1?lang=ger&ContentOnly=&message=';
      const detail = 'https://recruitingapp-2563.umantis.com/Vacancies/559/Description/1';
      const title = 'Chief Information Officer (80-100%) in Zürich';
      const listing = `<html><body><a href="/Vacancies/559/Description/1">${title}</a></body></html>`;
      const detailBody = 'Aufgaben und Verantwortlichkeiten für diese Stelle. '.repeat(40);
      const detailHtml = `<html><body><div class="content">
        <div class="text"><p>Switch Unternehmensporträt.</p></div>
        <h1>${title}</h1><div class="s1">Dein Team und deine Arbeit</div>
        <p>${detailBody}</p>
        <div id="mg_footer"><p>Kontakt und Bewerbungsprozess.</p></div>
      </div></body></html>`;
      const fetchImpl = async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /', { status: 200 });
        if (url === seed) return new Response(listing, { status: 200 });
        if (url === detail) return new Response(detailHtml, { status: 200 });
        throw new Error(`unexpected URL ${url}`);
      };

      await expect(fetchAllRecruitingapp2563Jobs({
        fetchImpl,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => {},
        hostDelayMs: 0,
        retries: 0,
        disableWafProxy: true,
      })).resolves.toEqual([expect.objectContaining({
        title,
        location: 'Zürich',
        canton: 'ZH',
        addressLocality: 'Zürich',
        addressRegion: 'ZH',
        addressCountry: 'CH',
        description: expect.stringContaining('Aufgaben und Verantwortlichkeiten'),
      })]);
    });
  });

  // ── isCompanyJob ──
  describe('isRecruitingapp2563Job', () => {
    it('matches by companyKey', () => {
      expect(isRecruitingapp2563Job({ companyKey: 'recruitingapp-2563' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRecruitingapp2563Job({ company: 'Switch Bewerbermanagement Stellen' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isRecruitingapp2563Job({ url: 'https://recruitingapp-2563.umantis.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRecruitingapp2563Job({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRecruitingapp2563Job(null)).toBe(false);
      expect(isRecruitingapp2563Job(undefined)).toBe(false);
      expect(isRecruitingapp2563Job({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://recruitingapp-2563.umantis.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.recruitingapp-2563.umantis.com/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
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
      expect(slugify('Developer recruitingapp-2563 ch')).toBe('developer-recruitingapp-2563-ch');
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
      id: 'recruitingapp-2563-abc123',
      slug: 'test-position-recruitingapp-2563-ch',
      slugByLocale: { de: 'test-position-recruitingapp-2563-ch' },
      company: 'Switch Bewerbermanagement Stellen',
      companyKey: 'recruitingapp-2563',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://recruitingapp-2563.umantis.com/jobs/test',
      source: 'Switch Bewerbermanagement Stellen Dedicated Parser',
      sourceLang: 'de',
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
      expect(validJob.id).toMatch(/^recruitingapp-2563-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
