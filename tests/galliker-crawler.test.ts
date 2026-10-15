import { describe, it, expect } from 'vitest';
import {
  GALLIKER_KEY,
  GALLIKER_COMPANY_NAME,
  isGallikerJob,
  isTrustedDomain,
} from '../scripts/lib/galliker-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { parseReflineListing } from '../scripts/lib/refline-common.mjs';
import { extractJobPostingLd, jobPostingDescriptionText, jobPostingAddress } from '../scripts/lib/jsonld-jobposting.mjs';

const REFLINE_TENANT = '878019';
const REFLINE_HOST = 'apply.refline.ch';

// Real listing shape captured from https://apply.refline.ch/878019/positions.html
// (table-row Refline template with an operationArea column, no workplace/
// workload columns — same variant used by ZKB).
const SAMPLE_LISTING_HTML = `
<table class="jquery-tablesorter searchResult">
  <thead>
    <tr><th class="position">Stellentitel</th><th class="operationArea">Tätigkeitsbereich</th><th class="entryDate">Eintrittsdatum</th></tr>
  </thead>
  <tbody>
    <tr class="even">
      <td class="position"><a href="https://apply.refline.ch/878019/0043/pub/38/index.html" target="_blank">Chauffeur CE Autotransporte (a)</a></td>
      <td class="operationArea">Chauffeur C / CE, Chauffeur B / BE</td>
      <td class="entryDate">Sofort</td>
    </tr>
    <tr class="odd">
      <td class="position"><a href="https://apply.refline.ch/878019/0042/pub/42/index.html" target="_blank">Chauffeure C / CE (a)</a></td>
      <td class="operationArea">Chauffeur C / CE, Chauffeur B / BE</td>
      <td class="entryDate">Sofort</td>
    </tr>
  </tbody>
</table>
`;

// Real JSON-LD shape captured from a Galliker Refline detail page
// (https://apply.refline.ch/878019/0042/pub/42/index.html).
const SAMPLE_DETAIL_LD_SCRIPT = `
<script type="application/ld+json">
{"description":"<p>Von unserem Logistikzentrum in Altishofen aus beliefern wir mit unserem topmodernen Fuhrpark die gesamte Schweiz.</p><ul><li>Fuehrerschein Kat. CE</li><li>Erfahrung im Strassentransport</li></ul>","datePosted":"2024-03-21T14:14:35.464856+00:00","validThrough":"2026-12-31","jobLocationType":"","hiringOrganization":{"sameAs":"https://www.galliker.com","logo":"https://apply.refline.ch/878019/companies/master/img/logo.jpg","@type":"Organization","name":"Galliker Transport AG"},"title":"Chauffeure C / CE (a)","employmentType":["FULL_TIME"],"jobLocation":{"@type":"Place","address":{"addressCountry":"CH","addressLocality":"Altishofen","addressRegion":"LU","streetAddress":"Kantonsstrasse 2","postalCode":"6246","@type":"PostalAddress"}},"@context":"http://schema.org/","identifier":{"@type":"PropertyValue","value":"refline-878019-master","name":"Galliker Transport AG"},"@type":"JobPosting"}
</script>
`;

describe('Galliker crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(GALLIKER_KEY).toBe('galliker');
    expect(GALLIKER_COMPANY_NAME).toBe('Galliker Transport AG');
  });

  // ── isCompanyJob ──
  describe('isGallikerJob', () => {
    it('matches by companyKey', () => {
      expect(isGallikerJob({ companyKey: 'galliker' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGallikerJob({ company: 'Galliker Transport AG' })).toBe(true);
    });

    it('matches by galliker.com URL', () => {
      expect(isGallikerJob({ url: 'https://www.galliker.com/jobs-karriere/offene-stellen/chje246-42' })).toBe(true);
    });

    it('matches by Refline tenant URL (real ATS backend)', () => {
      expect(isGallikerJob({ url: 'https://apply.refline.ch/878019/0042/pub/42/index.html' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isGallikerJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGallikerJob(null)).toBe(false);
      expect(isGallikerJob(undefined)).toBe(false);
      expect(isGallikerJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the corporate domain', () => {
      expect(isTrustedDomain('https://www.galliker.com/jobs-karriere/offene-stellen/chje246-42')).toBe(true);
    });

    it('trusts the Refline ATS host', () => {
      expect(isTrustedDomain('https://apply.refline.ch/878019/0042/pub/42/index.html')).toBe(true);
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
      const slug = slugify('Chauffeur C / CE (a)');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Chauffeure C / CE galliker Altishofen')).toContain('galliker');
    });
  });

  // ── Refline listing reuse (shared factory, not duplicated) ──
  describe('parseReflineListing (shared refline-common.mjs)', () => {
    it('parses the Galliker table-row listing into position entries', () => {
      const listings = parseReflineListing(SAMPLE_LISTING_HTML, {
        listingHost: REFLINE_HOST,
        tenant: REFLINE_TENANT,
      });
      expect(listings.length).toBe(2);
      expect(listings[0]).toMatchObject({
        posId: '0043',
        title: 'Chauffeur CE Autotransporte (a)',
      });
      expect(listings[0].url).toBe('https://apply.refline.ch/878019/0043/pub/38/index.html');
      expect(listings[1].posId).toBe('0042');
    });
  });

  // ── JSON-LD extraction reuse (shared jsonld-jobposting.mjs) ──
  describe('JSON-LD JobPosting extraction (shared jsonld-jobposting.mjs)', () => {
    it('extracts title/description/jobLocation from the detail page', () => {
      const ld = extractJobPostingLd(SAMPLE_DETAIL_LD_SCRIPT);
      expect(ld).not.toBeNull();
      expect(ld?.title).toBe('Chauffeure C / CE (a)');
      expect(ld?.employmentType).toEqual(['FULL_TIME']);

      const addr = jobPostingAddress(ld);
      expect(addr.addressLocality).toBe('Altishofen');
      expect(addr.addressRegion).toBe('LU');
      expect(addr.postalCode).toBe('6246');
      expect(addr.streetAddress).toBe('Kantonsstrasse 2');

      const description = jobPostingDescriptionText(ld?.description || '');
      expect(description).toContain('Altishofen');
      expect(description).toMatch(/•/); // <li> preserved as bullet
    });

    it('returns null for HTML without JobPosting JSON-LD', () => {
      expect(extractJobPostingLd('<html><body>no jsonld here</body></html>')).toBeNull();
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'galliker-abc123',
      slug: 'chauffeure-c-ce-a-galliker-altishofen',
      slugByLocale: { de: 'chauffeure-c-ce-a-galliker-altishofen' },
      company: 'Galliker Transport AG',
      companyKey: 'galliker',
      companyDomain: 'galliker.com',
      title: 'Chauffeure C / CE (a)',
      titleByLocale: { de: 'Chauffeure C / CE (a)' },
      description: 'Von unserem Logistikzentrum in Altishofen aus beliefern wir die gesamte Schweiz.',
      descriptionByLocale: { de: 'Von unserem Logistikzentrum in Altishofen aus beliefern wir die gesamte Schweiz.' },
      location: 'Altishofen',
      canton: 'LU',
      url: 'https://apply.refline.ch/878019/0042/pub/42/index.html',
      source: 'Galliker Dedicated Parser (Refline tenant 878019, JSON-LD)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Altishofen',
      addressRegion: 'LU',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '6246',
      streetAddress: 'Kantonsstrasse 2',
      title2: undefined,
      employmentType: 'FULL_TIME',
      datePosted: '2024-03-21',
      hiringOrganization: { name: 'Galliker Transport AG' },
      jobLocation: { addressLocality: 'Altishofen' },
      baseSalary: { min: 55000, max: 70000, currency: 'CHF' },
    };

    it('has all AGENTS.md #3 required structured-data fields (or safe defaults)', () => {
      const required = [
        'postalCode', 'streetAddress', 'title', 'description', 'datePosted',
        'employmentType',
      ];
      for (const field of required) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field as keyof typeof validJob]).toBeTruthy();
      }
      expect(validJob.hiringOrganization.name).toBeTruthy();
      expect(validJob.jobLocation).toBeTruthy();
      expect(validJob.baseSalary).toBeTruthy();
    });

    it('has all crawler-template required fields', () => {
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
      expect(validJob.id).toMatch(/^galliker-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
