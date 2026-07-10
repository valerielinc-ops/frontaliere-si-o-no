import { describe, it, expect } from 'vitest';
import {
  PICTET_KEY,
  PICTET_COMPANY_NAME,
  canonicalPictetDetailUrl,
  isPictetJob,
  isTrustedDomain,
} from '../scripts/lib/pictet-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { mergeUrlKey } from '../scripts/lib/job-url-key.mjs';

describe('Pictet Group crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(PICTET_KEY).toBe('pictet');
    expect(PICTET_COMPANY_NAME).toBe('Pictet Group');
  });

  // ── isCompanyJob ──
  describe('isPictetJob', () => {
    it('matches by companyKey', () => {
      expect(isPictetJob({ companyKey: 'pictet' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isPictetJob({ company: 'Pictet Group' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isPictetJob({ url: 'https://pictet.com/jobs/123' })).toBe(true);
    });

    it('matches by Banque Pictet variant', () => {
      expect(isPictetJob({ company: 'Banque Pictet & Cie SA' })).toBe(true);
    });

    it('matches by SuccessFactors career5 URL with company=banquepict', () => {
      expect(isPictetJob({ url: 'https://career012.successfactors.eu/career?company=banquepict&career_job_req_id=42' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isPictetJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isPictetJob(null)).toBe(false);
      expect(isPictetJob(undefined)).toBe(false);
      expect(isPictetJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://pictet.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.pictet.com/job/456')).toBe(true);
    });

    it('trusts SuccessFactors career5 URLs scoped to company=banquepict', () => {
      expect(isTrustedDomain('https://career012.successfactors.eu/career?company=banquepict&career_job_req_id=42')).toBe(true);
    });

    it('rejects SuccessFactors URLs for other tenants', () => {
      expect(isTrustedDomain('https://career012.successfactors.eu/career?company=otherbank')).toBe(false);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── canonicalPictetDetailUrl (session-token stripping, #dup incident 2026-07-10) ──
  describe('canonicalPictetDetailUrl', () => {
    const CANON =
      'https://career012.successfactors.eu/career?career_ns=job_listing&company=banquepict&navBarLevel=JOB_SEARCH&career_job_req_id=124662&selected_lang=en_GB';

    it('strips the per-session _s.crb CSRF token and session/tracking params', () => {
      const raw =
        'https://career012.successfactors.eu/career?career_ns=job_listing&company=banquepict&navBarLevel=JOB_SEARCH&rcm_site_locale=en_GB&career_job_req_id=124662&selected_lang=en_GB&jobAlertController_jobAlertId=&jobAlertController_jobAlertName=&browserTimeZone=Europe/Zurich&_s.crb=Gy5qV3NJeTxxbK2g2aIJK1YL9QocUPf1EyfOQgqItFU%3d';
      expect(canonicalPictetDetailUrl(raw)).toBe(CANON);
    });

    it('handles %5f-encoded param names harvested from the hydrated SPA', () => {
      const raw =
        'https://career012.successfactors.eu/career?career%5fns=job%5flisting&company=banquepict&navBarLevel=JOB%5fSEARCH&rcm%5fsite%5flocale=en%5fGB&career_job_req_id=124662&_s.crb=KX09qUvCIW%2fiyaN6omzaXMpm9JDRayuTMVoMs%2bgf8Ls%3d';
      expect(canonicalPictetDetailUrl(raw)).toBe(CANON);
    });

    it('collapses two per-run session variants of the SAME job onto ONE url (the dup incident)', () => {
      // Two crawls of the same posting, each with a fresh _s.crb — this is
      // exactly what fragmented pictet.json into 10→26 duplicates in one day.
      const runA =
        'https://career012.successfactors.eu/career?career_ns=job_listing&company=banquepict&navBarLevel=JOB_SEARCH&career_job_req_id=124662&selected_lang=en_GB&browserTimeZone=Europe/Zurich&_s.crb=Gy5qV3NJeTxxbK2g2aIJK1YL9QocUPf1EyfOQgqItFU%3d';
      const runB =
        'https://career012.successfactors.eu/career?career_ns=job_listing&company=banquepict&navBarLevel=JOB_SEARCH&career_job_req_id=124662&selected_lang=en_GB&browserTimeZone=Europe/Zurich&_s.crb=LM2i%2fZDuzpPPbMs0hZUIkGpFoDwyDGD%2bouTJJucx4WQ%3d';
      const a = canonicalPictetDetailUrl(runA);
      const b = canonicalPictetDetailUrl(runB);
      expect(a).toBe(b);
      // Simulate the discovery dedup: 2 variants → 1 detail URL → 1 job.
      const unique = new Set([a, b]);
      expect(unique.size).toBe(1);
    });

    it('keeps distinct reqIds distinct', () => {
      const a = canonicalPictetDetailUrl(
        'https://career012.successfactors.eu/career?company=banquepict&career_job_req_id=124662&_s.crb=x',
      );
      const b = canonicalPictetDetailUrl(
        'https://career012.successfactors.eu/career?company=banquepict&career_job_req_id=124666&_s.crb=x',
      );
      expect(a).not.toBe(b);
    });

    it('preserves the crawl-time merge key (num:<reqId>) so existing jobs keep matching', () => {
      expect(mergeUrlKey(CANON)).toBe('num:124662');
    });

    it('canonical URL is trusted and recognized as a Pictet job', () => {
      expect(isTrustedDomain(CANON)).toBe(true);
      expect(isPictetJob({ url: CANON })).toBe(true);
    });

    it('returns null for listing/root pages without a numeric reqId', () => {
      expect(canonicalPictetDetailUrl('https://career012.successfactors.eu/career?company=banquepict')).toBe(null);
      expect(canonicalPictetDetailUrl('https://career012.successfactors.eu/career?company=banquepict&career_job_req_id=abc')).toBe(null);
    });

    it('returns null for malformed input', () => {
      expect(canonicalPictetDetailUrl('')).toBe(null);
      expect(canonicalPictetDetailUrl('not-a-url')).toBe(null);
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
      expect(slugify('Developer pictet geneva')).toBe('developer-pictet-geneva');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (Pictet HQ Geneva).
    const validJob = {
      id: 'pictet-abc123',
      slug: 'wealth-manager-pictet-geneva',
      slugByLocale: { en: 'wealth-manager-pictet-geneva' },
      company: 'Pictet Group',
      companyKey: 'pictet',
      title: 'Wealth Manager',
      titleByLocale: { en: 'Wealth Manager' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Genève',
      canton: 'GE',
      url: 'https://career012.successfactors.eu/career?company=banquepict&career_job_req_id=42',
      source: 'Pictet Group Dedicated Parser (SuccessFactors career5)',
      sourceLang: 'en',
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
      expect(validJob.id).toMatch(/^pictet-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('default canton is GE (Pictet HQ Geneva)', () => {
      expect(validJob.canton).toBe('GE');
    });
  });
});
