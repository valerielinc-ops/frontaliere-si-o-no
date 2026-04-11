import { describe, it, expect } from 'vitest';
import {
  INTEGRA_BIOSCIENCES_KEY,
  INTEGRA_BIOSCIENCES_COMPANY_NAME,
  isIntegraBiosciencesJob,
  isTrustedDomain,
  parseListingTable,
  parseDetailPage,
  detectCategory,
  detectExperienceLevel,
  inferEmploymentType,
} from '../scripts/lib/integra-biosciences-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('INTEGRA Biosciences crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(INTEGRA_BIOSCIENCES_KEY).toBe('integra-biosciences');
    expect(INTEGRA_BIOSCIENCES_COMPANY_NAME).toBe('INTEGRA Biosciences');
  });

  // ── isCompanyJob ──
  describe('isIntegraBiosciencesJob', () => {
    it('matches by companyKey', () => {
      expect(isIntegraBiosciencesJob({ companyKey: 'integra-biosciences' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isIntegraBiosciencesJob({ company: 'INTEGRA Biosciences' })).toBe(true);
    });

    it('matches by company name case-insensitive', () => {
      expect(isIntegraBiosciencesJob({ company: 'integra biosciences AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isIntegraBiosciencesJob({ url: 'https://www.integra-biosciences.com/global/en/careers/senior-engineer' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isIntegraBiosciencesJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isIntegraBiosciencesJob(null)).toBe(false);
      expect(isIntegraBiosciencesJob(undefined)).toBe(false);
      expect(isIntegraBiosciencesJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://integra-biosciences.com/careers/job-123')).toBe(true);
    });

    it('trusts www subdomain', () => {
      expect(isTrustedDomain('https://www.integra-biosciences.com/global/en/careers/senior-engineer')).toBe(true);
    });

    it('trusts other subdomains', () => {
      expect(isTrustedDomain('https://careers.integra-biosciences.com/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('rejects similar but different domains', () => {
      expect(isTrustedDomain('https://fake-integra-biosciences.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── parseListingTable ──
  describe('parseListingTable', () => {
    const sampleHtml = `
      <table class="cols-3">
        <thead><tr>
          <th id="view-title-table-column" class="views-field views-field-title" scope="col">Title</th>
          <th id="view-field-business-area-table-column" class="views-field views-field-field-business-area" scope="col">Business Area</th>
          <th id="view-field-job-country-table-column" class="views-field views-field-field-job-country" scope="col">Country</th>
        </tr></thead>
        <tbody>
          <tr>
            <td headers="view-title-table-column" class="views-field views-field-title"><a href="/global/en/careers/senior-projektleiter-gerateentwicklung-mw-i-100" hreflang="en">Senior Projektleiter Geräteentwicklung (m/w I 100%)</a> </td>
            <td headers="view-field-business-area-table-column" class="views-field views-field-field-business-area">Engineering </td>
            <td headers="view-field-job-country-table-column" class="views-field views-field-field-job-country">Switzerland </td>
          </tr>
          <tr>
            <td headers="view-title-table-column" class="views-field views-field-title"><a href="/global/en/careers/elektronikentwickler-mw-100" hreflang="en">Elektronikentwickler (m/w | 100%)</a> </td>
            <td headers="view-field-business-area-table-column" class="views-field views-field-field-business-area">Engineering </td>
            <td headers="view-field-job-country-table-column" class="views-field views-field-field-job-country">Switzerland </td>
          </tr>
          <tr>
            <td headers="view-title-table-column" class="views-field views-field-title"><a href="/global/en/careers/junior-controller-mw-80-100" hreflang="en">Junior Controller (m/w | 80-100%)</a> </td>
            <td headers="view-field-business-area-table-column" class="views-field views-field-field-business-area">Finance &amp; Administration </td>
            <td headers="view-field-job-country-table-column" class="views-field views-field-field-job-country">Switzerland </td>
          </tr>
          <tr>
            <td headers="view-title-table-column" class="views-field views-field-title"><a href="/global/en/careers/content-marketing-manager-mf-80-100" hreflang="en">Content Marketing Manager (m/f | 80-100%)</a> </td>
            <td headers="view-field-business-area-table-column" class="views-field views-field-field-business-area">Innovation </td>
            <td headers="view-field-job-country-table-column" class="views-field views-field-field-job-country">Switzerland </td>
          </tr>
        </tbody>
      </table>
    `;

    it('parses correct number of jobs from table', () => {
      const jobs = parseListingTable(sampleHtml);
      expect(jobs).toHaveLength(4);
    });

    it('extracts job titles correctly', () => {
      const jobs = parseListingTable(sampleHtml);
      expect(jobs[0].title).toBe('Senior Projektleiter Geräteentwicklung (m/w I 100%)');
      expect(jobs[1].title).toBe('Elektronikentwickler (m/w | 100%)');
      expect(jobs[2].title).toBe('Junior Controller (m/w | 80-100%)');
      expect(jobs[3].title).toBe('Content Marketing Manager (m/f | 80-100%)');
    });

    it('extracts detail URLs correctly', () => {
      const jobs = parseListingTable(sampleHtml);
      expect(jobs[0].detailUrl).toBe('https://www.integra-biosciences.com/global/en/careers/senior-projektleiter-gerateentwicklung-mw-i-100');
      expect(jobs[1].detailUrl).toBe('https://www.integra-biosciences.com/global/en/careers/elektronikentwickler-mw-100');
    });

    it('extracts business area correctly', () => {
      const jobs = parseListingTable(sampleHtml);
      expect(jobs[0].businessArea).toBe('Engineering');
      expect(jobs[2].businessArea).toBe('Finance & Administration');
      expect(jobs[3].businessArea).toBe('Innovation');
    });

    it('extracts country correctly', () => {
      const jobs = parseListingTable(sampleHtml);
      expect(jobs[0].country).toBe('Switzerland');
    });

    it('returns empty array for empty/short HTML', () => {
      expect(parseListingTable('')).toEqual([]);
      expect(parseListingTable('short')).toEqual([]);
    });

    it('skips rows without valid titles', () => {
      const html = `
        <tr>
          <td class="views-field views-field-title"><a href="/careers/x" hreflang="en">AB</a></td>
          <td class="views-field views-field-field-business-area">IT</td>
          <td class="views-field views-field-field-job-country">Switzerland</td>
        </tr>
      `;
      expect(parseListingTable(html)).toEqual([]);
    });

    it('handles absolute URLs in href', () => {
      const html = `
        <tr>
          <td class="views-field views-field-title"><a href="https://www.integra-biosciences.com/global/en/careers/test-job" hreflang="en">Test Job Engineer (100%)</a></td>
          <td class="views-field views-field-field-business-area">Engineering</td>
          <td class="views-field views-field-field-job-country">Switzerland</td>
        </tr>
      `;
      const jobs = parseListingTable(html);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].detailUrl).toBe('https://www.integra-biosciences.com/global/en/careers/test-job');
    });
  });

  // ── parseDetailPage ──
  describe('parseDetailPage', () => {
    it('extracts description from JSON-LD', () => {
      const html = `
        <html>
        <script type="application/ld+json">
        {
          "@type": "JobPosting",
          "description": "<p>We are looking for a <strong>Senior Engineer</strong> to join our team.</p>",
          "datePosted": "2026-03-15"
        }
        </script>
        </html>
      `;
      const result = parseDetailPage(html);
      expect(result.description).toContain('Senior Engineer');
      expect(result.datePosted).toBe('2026-03-15');
    });

    it('falls back to field--name-body', () => {
      const html = `
        <div class="field field--name-body field--type-text-with-summary">
          <div class="field__item">
            <p>This is a great opportunity to work at INTEGRA Biosciences in Zizers.</p>
          </div>
        </div>
      `;
      const result = parseDetailPage(html);
      expect(result.description).toContain('great opportunity');
    });

    it('falls back to article content', () => {
      const html = `
        <article class="node node--type-job-offer">
          <div class="content">
            <p>INTEGRA Biosciences is seeking a motivated software developer to join our innovation team in Zizers.</p>
          </div>
        </article>
      `;
      const result = parseDetailPage(html);
      expect(result.description).toContain('software developer');
    });

    it('returns empty for short/empty HTML', () => {
      expect(parseDetailPage('')).toEqual({ description: '', datePosted: '' });
      expect(parseDetailPage('short')).toEqual({ description: '', datePosted: '' });
    });
  });

  // ── detectCategory ──
  describe('detectCategory', () => {
    it('maps business area "Engineering"', () => {
      expect(detectCategory('Some Title', 'Engineering')).toBe('Ingegneria');
    });

    it('maps business area "Finance & Administration"', () => {
      expect(detectCategory('Controller', 'Finance & Administration')).toBe('Amministrazione');
    });

    it('maps business area "IT"', () => {
      expect(detectCategory('System Admin', 'IT')).toBe('IT');
    });

    it('maps business area "Sales"', () => {
      expect(detectCategory('Regional Manager', 'Sales')).toBe('Commerciale');
    });

    it('maps business area "Production"', () => {
      expect(detectCategory('Operator', 'Production')).toBe('Produzione');
    });

    it('maps business area "Quality & Safety Management"', () => {
      expect(detectCategory('Inspector', 'Quality & Safety Management')).toBe('Qualità');
    });

    it('maps business area "Innovation"', () => {
      expect(detectCategory('Scientist', 'Innovation')).toBe('Ricerca e Sviluppo');
    });

    it('falls back to title-based detection for engineering', () => {
      expect(detectCategory('Mechanical Design Engineer (m/w | 100%)', '')).toBe('Ingegneria');
    });

    it('falls back to title-based detection for IT', () => {
      expect(detectCategory('Senior Software-Entwickler C# /.NET', '')).toBe('IT');
    });

    it('falls back to title-based detection for production', () => {
      expect(detectCategory('Fachspezialist Automation', '')).toBe('Produzione');
    });

    it('returns Altro for unknown categories', () => {
      expect(detectCategory('General Position', '')).toBe('Altro');
    });
  });

  // ── detectExperienceLevel ──
  describe('detectExperienceLevel', () => {
    it('detects senior level', () => {
      expect(detectExperienceLevel('Senior Projektleiter Geräteentwicklung')).toBe('senior');
      expect(detectExperienceLevel('Head of Engineering')).toBe('senior');
      expect(detectExperienceLevel('Lead Developer')).toBe('senior');
    });

    it('detects junior level', () => {
      expect(detectExperienceLevel('Junior Controller (m/w | 80-100%)')).toBe('junior');
    });

    it('detects intern level', () => {
      expect(detectExperienceLevel('Praktikant Engineering')).toBe('intern');
      expect(detectExperienceLevel('Lernende/r Informatik')).toBe('intern');
    });

    it('defaults to mid level', () => {
      expect(detectExperienceLevel('Elektronikentwickler (m/w | 100%)')).toBe('mid');
      expect(detectExperienceLevel('Application Scientist (m/f | 100%)')).toBe('mid');
    });
  });

  // ── inferEmploymentType ──
  describe('inferEmploymentType', () => {
    it('detects full-time from 100%', () => {
      expect(inferEmploymentType('Elektronikentwickler (m/w | 100%)')).toBe('FULL_TIME');
    });

    it('detects full-time from 80-100%', () => {
      expect(inferEmploymentType('Junior Controller (m/w | 80-100%)')).toBe('FULL_TIME');
    });

    it('detects part-time from 60-80%', () => {
      expect(inferEmploymentType('Sachbearbeiter (m/w | 60-80%)')).toBe('PART_TIME');
    });

    it('detects part-time from 50%', () => {
      expect(inferEmploymentType('Teilzeitstelle (50%)')).toBe('PART_TIME');
    });

    it('defaults to full-time when no percentage', () => {
      expect(inferEmploymentType('Application Scientist')).toBe('FULL_TIME');
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

    it('handles German umlauts', () => {
      expect(slugify('Geräteentwicklung')).toBe('gerateentwicklung');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer integra-biosciences ch')).toBe('developer-integra-biosciences-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'integra-biosciences-abc123def456',
      slug: 'senior-projektleiter-gerateentwicklung-integra-biosciences-ch',
      slugByLocale: { de: 'senior-projektleiter-gerateentwicklung-integra-biosciences-ch' },
      company: 'INTEGRA Biosciences',
      companyKey: 'integra-biosciences',
      companyDomain: 'integra-biosciences.com',
      title: 'Senior Projektleiter Geräteentwicklung (m/w I 100%)',
      titleByLocale: { de: 'Senior Projektleiter Geräteentwicklung (m/w I 100%)' },
      description: 'Senior Projektleiter Geräteentwicklung — INTEGRA Biosciences. Business Area: Engineering. Location: Zizers (GR), Switzerland.',
      descriptionByLocale: { de: 'Senior Projektleiter Geräteentwicklung — INTEGRA Biosciences. Business Area: Engineering. Location: Zizers (GR), Switzerland.' },
      location: 'Zizers',
      canton: 'GR',
      url: 'https://www.integra-biosciences.com/global/en/careers/senior-projektleiter-gerateentwicklung-mw-i-100',
      source: 'INTEGRA Biosciences Dedicated Parser',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Zizers',
      postalCode: '7205',
      streetAddress: 'Tardisstrasse 201',
      addressCountry: 'CH',
      country: 'CH',
      category: 'Ingegneria',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: 'senior',
      sector: 'Scienze della Vita / Biotecnologia',
      currency: 'CHF',
      featured: false,
      postedDate: '2026-03-15',
      applyUrl: 'https://www.integra-biosciences.com/global/en/careers/senior-projektleiter-gerateentwicklung-mw-i-100',
      requirements: [],
      requirementsByLocale: { de: [] },
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

    it('has all SEO-mandatory fields', () => {
      const seoRequired = [
        'postalCode', 'streetAddress', 'addressLocality',
        'addressCountry', 'employmentType', 'sector',
      ];
      for (const field of seoRequired) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field as keyof typeof validJob]).toBeTruthy();
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^integra-biosciences-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('location is Zizers (INTEGRA HQ)', () => {
      expect(validJob.location).toBe('Zizers');
      expect(validJob.canton).toBe('GR');
      expect(validJob.postalCode).toBe('7205');
    });

    it('has correct sector for life sciences company', () => {
      expect(validJob.sector).toBe('Scienze della Vita / Biotecnologia');
    });
  });
});
