import { describe, it, expect } from 'vitest';
import {
  CSEB_KEY,
  CSEB_COMPANY_NAME,
  isCsebJob,
  isTrustedDomain,
  parseCsebPublication,
} from '../scripts/lib/cseb-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Center da Sanadad Engiadina Bassa crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CSEB_KEY).toBe('cseb');
    expect(CSEB_COMPANY_NAME).toBe('Center da Sanadad Engiadina Bassa');
  });

  // ── isCompanyJob ──
  describe('isCsebJob', () => {
    it('matches by companyKey', () => {
      expect(isCsebJob({ companyKey: 'cseb' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCsebJob({ company: 'Center da Sanadad Engiadina Bassa' })).toBe(true);
    });

    it('matches by German name variant', () => {
      expect(isCsebJob({ company: 'Gesundheitszentrum Unterengadin' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isCsebJob({ url: 'https://cseb.ch/jobs/123' })).toBe(true);
    });

    it('matches by jobs subdomain URL', () => {
      expect(isCsebJob({ url: 'https://jobs.cseb.ch/job-advertisement/abc' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCsebJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCsebJob(null)).toBe(false);
      expect(isCsebJob(undefined)).toBe(false);
      expect(isCsebJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://cseb.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://jobs.cseb.ch/job-advertisement/abc')).toBe(true);
    });

    it('trusts abaservices.ch API domain', () => {
      expect(isTrustedDomain('https://api.jobportal.abaservices.ch/api/publication')).toBe(true);
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
      const slug = slugify('Dipl. Rettungssanitäter/-in SRK/HF');
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(slug).toContain('rettungssanitater');
    });

    it('strips diacritics', () => {
      expect(slugify('Fachfrau Gesundheit')).toBe('fachfrau-gesundheit');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer cseb ch')).toBe('developer-cseb-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── parseCsebPublication ──
  describe('parseCsebPublication', () => {
    const basePub = {
      JobTitle: 'Dipl. Rettungssanitäter/-in SRK/HF (40-100%)',
      JobId: '12345678-abcd-ef01-2345-678901234567',
      PublicationId: 'aabbccdd-1122-3344-5566-778899001122',
      PublicationUrlAbacusJobPortal: 'https://jobs.cseb.ch/job-advertisement/d9c5a048-f665-4e64-a2c7-cdd8231bac77/aabbccdd-1122-3344-5566-778899001122',
      ApplicationUrl: 'https://jobs.cseb.ch/application-process/d9c5a048-f665-4e64-a2c7-cdd8231bac77/aabbccdd-1122-3344-5566-778899001122',
      PlaceOfWorkCity: 'Scuol',
      PlaceOfWorkZip: '7550',
      PlaceOfWorkStreet: "Via da l'Ospidal",
      PlaceOfWorkHouseNumber: '280',
      CompanyState: 'GR',
      CompanyName: 'CSEB',
      PublicationLanguage: 'de',
      PublicationStartDate: '2025-11-12',
      PositionLevelOfEmployment: '0',
      Tasks: '&lt;p&gt;Rotierende Betreuung von Patienten&lt;/p&gt;',
      Requirements: '&lt;p&gt;Diplomierte Rettungssanitäterin&lt;/p&gt;',
      Benefits: '&lt;p&gt;Attraktive Anstellungsbedingungen&lt;/p&gt;',
      Organization: '&lt;p&gt;Center da sandà Engiadina Bassa&lt;/p&gt;',
      Introduction: '',
      Closure: '',
      HrResponsibleFirstName: 'Corsina',
      HrResponsibleLastName: 'Feuerstein Betschart',
    };

    it('parses a standard publication into a valid job', () => {
      const job = parseCsebPublication(basePub);
      expect(job).not.toBeNull();
      expect(job.title).toBe('Dipl. Rettungssanitäter/-in SRK/HF (40-100%)');
      expect(job.company).toBe('Center da Sanadad Engiadina Bassa');
      expect(job.companyKey).toBe('cseb');
      expect(job.location).toBe('Scuol');
      expect(job.canton).toBe('GR');
      expect(job.postalCode).toBe('7550');
      expect(job.streetAddress).toBe("Via da l'Ospidal 280");
      expect(job.sourceLang).toBe('de');
      expect(job.sector).toBe('Sanità / Assistenza');
      expect(job.addressCountry).toBe('CH');
    });

    it('generates stable ID from JobId', () => {
      const job = parseCsebPublication(basePub);
      expect(job.id).toMatch(/^cseb-[a-f0-9]{12}$/);
      // Same input produces same ID
      const job2 = parseCsebPublication(basePub);
      expect(job2.id).toBe(job.id);
    });

    it('detects pensum from title', () => {
      const job = parseCsebPublication(basePub);
      expect(job.pensumMin).toBe(40);
      expect(job.pensumMax).toBe(100);
      expect(job.pensum).toBe('40 - 100%');
    });

    it('detects employment type from pensum', () => {
      // 40-100% means max is 100 >= 80 => FULL_TIME
      const job = parseCsebPublication(basePub);
      expect(job.employmentType).toBe('FULL_TIME');
    });

    it('detects PART_TIME for low pensum', () => {
      const pub = { ...basePub, JobTitle: 'Mitarbeiter/-in Hauswirtschaft (50-60%)' };
      const job = parseCsebPublication(pub);
      expect(job.employmentType).toBe('PART_TIME');
      expect(job.pensumMax).toBe(60);
    });

    it('detects emergency category for Rettungssanitäter', () => {
      const job = parseCsebPublication(basePub);
      expect(job.category).toBe('Emergenza');
    });

    it('detects nursing category for Pflegefachfrau', () => {
      const pub = { ...basePub, JobTitle: 'Dipl. Pflegefachfrau/-mann HF (80-100%)' };
      const job = parseCsebPublication(pub);
      expect(job.category).toBe('Infermieristica');
    });

    it('detects medicine category for Assistenzärzte', () => {
      const pub = { ...basePub, JobTitle: 'Assistenzärztinnen / Assistenzärzte (70-100%)' };
      const job = parseCsebPublication(pub);
      expect(job.category).toBe('Medicina');
    });

    it('detects intern experience for Lehrstelle', () => {
      const pub = { ...basePub, JobTitle: 'Lehrstelle als Köchin / Koch EFZ' };
      const job = parseCsebPublication(pub);
      expect(job.experienceLevel).toBe('intern');
    });

    it('detects senior experience for Leitende Ärztin', () => {
      const pub = { ...basePub, JobTitle: 'Leitende Ärztin / Leitender Arzt Gynäkologie' };
      const job = parseCsebPublication(pub);
      expect(job.experienceLevel).toBe('senior');
    });

    it('builds description from HTML-encoded sections', () => {
      const job = parseCsebPublication(basePub);
      expect(job.description).toContain('Rotierende Betreuung von Patienten');
      expect(job.description).toContain('Diplomierte Rettungssanitäterin');
      expect(job.description).toContain('Attraktive Anstellungsbedingungen');
      // Should NOT contain HTML entities or tags
      expect(job.description).not.toContain('&lt;');
      expect(job.description).not.toContain('&gt;');
      expect(job.description).not.toContain('<p>');
    });

    it('uses fallback description when all sections empty', () => {
      const pub = {
        ...basePub,
        Tasks: '',
        Requirements: '',
        Benefits: '',
        Organization: '',
        Introduction: '',
        Closure: '',
      };
      const job = parseCsebPublication(pub);
      expect(job.description).toContain(job.title);
      expect(job.description).toContain('Center da Sanadad Engiadina Bassa');
    });

    it('sets correct URLs', () => {
      const job = parseCsebPublication(basePub);
      expect(job.url).toBe(basePub.PublicationUrlAbacusJobPortal);
      expect(job.applyUrl).toBe(basePub.ApplicationUrl);
    });

    it('extracts HR contact person', () => {
      const job = parseCsebPublication(basePub);
      expect(job.contactPerson).toBe('Corsina Feuerstein Betschart');
    });

    it('uses Designation01 as fallback title', () => {
      const pub = { ...basePub, JobTitle: '', Designation01: 'Fallback Job Title' };
      const job = parseCsebPublication(pub);
      expect(job.title).toBe('Fallback Job Title');
    });

    it('defaults to Scuol when location is missing', () => {
      const pub = { ...basePub, PlaceOfWorkCity: '', CompanyCity: '' };
      const job = parseCsebPublication(pub);
      expect(job.location).toBe('Scuol');
    });

    it('returns null for empty title', () => {
      const pub = { ...basePub, JobTitle: '', Designation01: '' };
      expect(parseCsebPublication(pub)).toBeNull();
    });

    it('returns null for very short title', () => {
      const pub = { ...basePub, JobTitle: 'ab', Designation01: '' };
      expect(parseCsebPublication(pub)).toBeNull();
    });

    it('skips plain Spontanbewerbung', () => {
      const pub = { ...basePub, JobTitle: 'Spontanbewerbung', Designation01: '' };
      expect(parseCsebPublication(pub)).toBeNull();
    });

    it('does NOT skip qualified Spontanbewerbung (with department)', () => {
      const pub = { ...basePub, JobTitle: 'Spontanbewerbung Pflegeberufe (Langzeitpflege)' };
      const job = parseCsebPublication(pub);
      expect(job).not.toBeNull();
      expect(job.title).toBe('Spontanbewerbung Pflegeberufe (Langzeitpflege)');
    });

    it('sets postedDate from PublicationStartDate', () => {
      const job = parseCsebPublication(basePub);
      expect(job.postedDate).toBe('2025-11-12');
    });

    it('slug contains company suffix', () => {
      const job = parseCsebPublication(basePub);
      expect(job.slug).toContain('cseb');
    });

    it('only has source locale in slugByLocale and titleByLocale', () => {
      const job = parseCsebPublication(basePub);
      expect(Object.keys(job.slugByLocale)).toEqual(['de']);
      expect(Object.keys(job.titleByLocale)).toEqual(['de']);
      expect(Object.keys(job.descriptionByLocale)).toEqual(['de']);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const pub = {
      JobTitle: 'Test Position (80-100%)',
      JobId: 'test-uuid-1234',
      PublicationId: 'pub-uuid-5678',
      PublicationUrlAbacusJobPortal: 'https://jobs.cseb.ch/job-advertisement/d9c5a048/pub-uuid-5678',
      ApplicationUrl: 'https://jobs.cseb.ch/application-process/d9c5a048/pub-uuid-5678',
      PlaceOfWorkCity: 'Scuol',
      PlaceOfWorkZip: '7550',
      PlaceOfWorkStreet: "Via da l'Ospidal",
      PlaceOfWorkHouseNumber: '280',
      CompanyState: 'GR',
      PublicationLanguage: 'de',
      PublicationStartDate: '2025-11-12',
      PositionLevelOfEmployment: '0',
      Tasks: '',
      Requirements: '',
      Benefits: '',
      Organization: '',
      Introduction: '',
      Closure: '',
      HrResponsibleFirstName: '',
      HrResponsibleLastName: '',
    };

    const validJob = parseCsebPublication(pub);

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

    it('has all recommended fields', () => {
      const recommended = [
        'addressLocality', 'postalCode', 'addressCountry', 'country',
        'category', 'contract', 'employmentType', 'experienceLevel',
        'sector', 'currency', 'featured', 'postedDate', 'applyUrl',
      ];
      for (const field of recommended) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^cseb-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
