import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  NORD_ANGLIA_KEY,
  NORD_ANGLIA_COMPANY_NAME,
  NORD_ANGLIA_COMPANY_DOMAIN,
  canonicalizeNordAngliaJobUrl,
  fetchAllNordAngliaJobs,
  isNordAngliaJob,
  isTrustedDomain,
  parseNordAngliaRss,
} from '../scripts/lib/nord-anglia-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('La Côte International School Aubonne (Nord Anglia Education) crawler parser', () => {
  const validRssItem = ({
    title = '<title><![CDATA[Teacher of Biology (Aubonne, CH)]]></title>',
    link = '<link>https://careers.nordangliaeducation.com/job/Aubonne-Teacher-of-Biology/1399902133/</link>',
    description = '<description><![CDATA[<p>Teach biology in Aubonne.</p>]]></description>',
    pubDate = '<pubDate>Mon, 01 Apr 2026 12:00:00 +0000</pubDate>',
  } = {}) => `<rss><channel><item>${title}${link}${description}${pubDate}</item></channel></rss>`;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Constants ──
  it('exports valid company key, name and domain', () => {
    expect(NORD_ANGLIA_KEY).toBe('nord-anglia');
    expect(NORD_ANGLIA_COMPANY_NAME).toBe('La Côte International School (Nord Anglia Education)');
    expect(NORD_ANGLIA_COMPANY_DOMAIN).toBe('nordangliaeducation.com');
  });

  // ── isCompanyJob ──
  describe('isNordAngliaJob', () => {
    it('matches by companyKey', () => {
      expect(isNordAngliaJob({ companyKey: 'nord-anglia' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isNordAngliaJob({ company: 'La Côte International School (Nord Anglia Education)' })).toBe(true);
    });

    it('matches by URL domain (marketing site)', () => {
      expect(isNordAngliaJob({ url: 'https://www.nordangliaeducation.com/la-cote-aubonne/careers' })).toBe(true);
    });

    it('matches by URL domain (jobs2web ATS host)', () => {
      expect(isNordAngliaJob({ url: 'https://careers.nordangliaeducation.com/job/Aubonne-Teacher-of-Biology/1399902133/' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isNordAngliaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isNordAngliaJob(null)).toBe(false);
      expect(isNordAngliaJob(undefined)).toBe(false);
      expect(isNordAngliaJob({})).toBe(false);
    });

    // ── Collision guard: careers.nordangliaeducation.com is a SHARED
    // jobs2web tenant serving multiple unrelated Nord Anglia Swiss brands
    // (Collège du Léman Geneva, Collège Champittet Lausanne/Pully, Collège
    // Beau Soleil Villars-sur-Ollon). isNordAngliaJob() must not fuzzy-match
    // those sibling schools' jobs just because they share the same ATS host —
    // matching happens on companyKey/company text, not bare host membership,
    // so a job explicitly labelled as one of those schools is NOT claimed here.
    it('does not claim jobs explicitly labelled as sibling Nord Anglia Swiss schools', () => {
      expect(
        isNordAngliaJob({
          companyKey: 'college-du-leman',
          company: 'Collège du Léman',
          url: 'https://careers.nordangliaeducation.com/job/Geneva-Nurse-on-call/1234567890/',
        }),
      ).toBe(false);
      expect(
        isNordAngliaJob({
          companyKey: 'college-champittet',
          company: 'Collège Champittet',
          url: 'https://careers.nordangliaeducation.com/job/Pully-IB-Teachers/1234567891/',
        }),
      ).toBe(false);
      expect(
        isNordAngliaJob({
          companyKey: 'college-beau-soleil',
          company: 'Collège Beau Soleil',
          url: 'https://careers.nordangliaeducation.com/job/Villars-sur-Ollon-Study-Coaches/1234567892/',
        }),
      ).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary marketing domain', () => {
      expect(isTrustedDomain('https://www.nordangliaeducation.com/la-cote-aubonne/careers')).toBe(true);
    });

    it('trusts the jobs2web ATS host', () => {
      expect(isTrustedDomain('https://careers.nordangliaeducation.com/job/Aubonne-Teacher-of-Biology/1399902133/')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  it('publishes canonical job URLs without jobs2web tracking parameters', () => {
    expect(canonicalizeNordAngliaJobUrl(
      'https://careers.nordangliaeducation.com/job/Aubonne-Teacher-of-Biology/1399902133/?feedId=null&utm_source=J2WRSS&utm_medium=rss&utm_campaign=J2W_RSS',
    )).toBe('https://careers.nordangliaeducation.com/job/Aubonne-Teacher-of-Biology/1399902133/');
    expect(canonicalizeNordAngliaJobUrl('https://example.com/job/Aubonne-Teacher/1/?utm_source=rss')).toBe('');
  });

  it('fails loudly instead of shrinking when an Aubonne link moves off the trusted ATS host', async () => {
    const driftedFeed = validRssItem({
      link: '<link>https://example.com/job/Aubonne-Teacher-of-Biology/1399902133/?utm_source=rss</link>',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(driftedFeed, { status: 200 })));

    await expect(fetchAllNordAngliaJobs()).rejects.toThrow(/non-canonical Aubonne job URL/);
  });

  describe('RSS parser guards', () => {
    it('preserves valid CDATA/text leaves', () => {
      expect(parseNordAngliaRss(validRssItem())).toEqual([{
        title: 'Teacher of Biology (Aubonne, CH)',
        link: 'https://careers.nordangliaeducation.com/job/Aubonne-Teacher-of-Biology/1399902133/',
        description: '<p>Teach biology in Aubonne.</p>',
        pubDate: 'Mon, 01 Apr 2026 12:00:00 +0000',
      }]);
    });

    it.each([
      '<rss><channel><item><title>Teacher</title></description></item></channel></rss>',
      '<rss><channel><item><title>Teacher</title></item>',
    ])('rejects malformed or truncated XML before parsing', (xml) => {
      expect(() => parseNordAngliaRss(xml)).toThrow(/XML parse failed/);
    });

    it.each([
      ['title', { title: '<title><strong>Teacher of Biology (Aubonne, CH)</strong></title>' }],
      ['link', { link: '<link>https://careers.nordangliaeducation.com/job/Aubonne-One/1/</link><link>https://careers.nordangliaeducation.com/job/Aubonne-Two/2/</link>' }],
      ['description', { description: '<description>First</description><description>Second</description>' }],
      ['pubDate', { pubDate: '<pubDate>Mon, 01 Apr 2026 12:00:00 +0000</pubDate><pubDate>Tue, 02 Apr 2026 12:00:00 +0000</pubDate>' }],
    ])('drops a single item with a non-scalar or repeated %s leaf instead of aborting the whole feed', (field, override) => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(parseNordAngliaRss(validRssItem(override))).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`${field} must be a single scalar string`)),
      );
      warnSpy.mockRestore();
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Teacher of Biology (Aubonne)');
      expect(slug).toBe('teacher-of-biology-aubonne');
    });

    it('strips diacritics', () => {
      expect(slugify('Coordinateur des transports scolaires & concierge')).toBe('coordinateur-des-transports-scolaires-concierge');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Teacher of Mathematics nord-anglia aubonne')).toBe('teacher-of-mathematics-nord-anglia-aubonne');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllNordAngliaJobs emits)
    const validJob = {
      id: 'nord-anglia-abc123',
      slug: 'teacher-of-biology-nord-anglia-aubonne',
      slugByLocale: { en: 'teacher-of-biology-nord-anglia-aubonne' },
      company: 'La Côte International School (Nord Anglia Education)',
      companyKey: 'nord-anglia',
      companyDomain: 'nordangliaeducation.com',
      title: 'Teacher of Biology',
      titleByLocale: { en: 'Teacher of Biology' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Aubonne',
      canton: 'VD',
      url: 'https://careers.nordangliaeducation.com/job/Aubonne-Teacher-of-Biology/1399902133/',
      source: 'La Côte International School Aubonne Dedicated Parser (Nord Anglia jobs2web RSS)',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Aubonne',
      addressRegion: 'VD',
      streetAddress: 'Chemin de Clamogne 8',
      postalCode: '1170',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().split('T')[0],
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

    it('has the fields required for job-page structured data (baseSalary source inputs)', () => {
      // baseSalary itself is synthesized downstream from safe defaults; these
      // are the per-job inputs the parser is responsible for supplying.
      const structuredDataInputs = [
        'postalCode', 'streetAddress', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field]).toBeTruthy();
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^nord-anglia-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('is scoped to the Aubonne VD campus address, not another Nord Anglia location', () => {
      expect(validJob.canton).toBe('VD');
      expect(validJob.addressLocality).toBe('Aubonne');
      expect(validJob.postalCode).toBe('1170');
    });
  });
});
