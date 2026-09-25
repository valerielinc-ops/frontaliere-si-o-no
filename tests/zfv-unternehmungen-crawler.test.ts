import { describe, it, expect } from 'vitest';
import {
  ZFV_UNTERNEHMUNGEN_KEY,
  ZFV_UNTERNEHMUNGEN_COMPANY_NAME,
  isZfvUnternehmungenJob,
  isTrustedDomain,
  extractJobPostingJsonLd,
} from '../scripts/lib/zfv-unternehmungen-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { parseRexxListing } from '../scripts/lib/rexx-systems-job-parser-common.mjs';

describe('ZFV-Unternehmungen crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ZFV_UNTERNEHMUNGEN_KEY).toBe('zfv-unternehmungen');
    expect(ZFV_UNTERNEHMUNGEN_COMPANY_NAME).toBe('ZFV-Unternehmungen');
  });

  // ── isCompanyJob ──
  describe('isZfvUnternehmungenJob', () => {
    it('matches by companyKey', () => {
      expect(isZfvUnternehmungenJob({ companyKey: 'zfv-unternehmungen' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isZfvUnternehmungenJob({ company: 'ZFV-Unternehmungen' })).toBe(true);
    });

    it('matches by URL domain (jobs.zfv.ch)', () => {
      expect(isZfvUnternehmungenJob({ url: 'https://jobs.zfv.ch/Sous-Chefin-de-j4192.html' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isZfvUnternehmungenJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isZfvUnternehmungenJob(null)).toBe(false);
      expect(isZfvUnternehmungenJob(undefined)).toBe(false);
      expect(isZfvUnternehmungenJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://zfv.ch/de/jobs')).toBe(true);
    });

    it('trusts jobs subdomain (ATS host)', () => {
      expect(isTrustedDomain('https://jobs.zfv.ch/Sous-Chefin-de-j4192.html')).toBe(true);
    });

    it('trusts www subdomain', () => {
      expect(isTrustedDomain('https://www.zfv.ch/de/impressum')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('rejects domains that contain zfv but are not subdomains', () => {
      expect(isTrustedDomain('https://notzfv.ch/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Sous-Chef:in (80%)');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('strips diacritics', () => {
      expect(slugify('Köchin/Koch')).toBe('kochin-koch');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Sous-Chefin zfv-unternehmungen Bern')).toMatch(/^sous-chefin-zfv-unternehmungen/);
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── parseRexxListing (shared factory, reused — not duplicated) ──
  describe('parseRexxListing (shared rexx-systems parser)', () => {
    it('extracts jobs from the ZFV joboffer_container markup', () => {
      const html = `
        <div class="joboffer_container" onclick="window.location.href='https://jobs.zfv.ch/Sous-Chefin-80-de-j4410.html'">
          <div class="joboffer_title_text joboffer_box">
            <a target="_self" href="https://jobs.zfv.ch/Sous-Chefin-80-de-j4410.html">Sous-Chef:in (80%)</a>
          </div>
        </div>
        <div class="joboffer_container" onclick="window.location.href='https://jobs.zfv.ch/Gouvernante-de-j4296.html'">
          <div class="joboffer_title_text joboffer_box">
            <a target="_self" href="https://jobs.zfv.ch/Gouvernante-de-j4296.html">Gouvernante:</a>
          </div>
        </div>
      `;
      const entries = parseRexxListing(html);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        id: '4410',
        title: 'Sous-Chef:in (80%)',
        detailUrl: 'https://jobs.zfv.ch/Sous-Chefin-80-de-j4410.html',
      });
      expect(entries[1].id).toBe('4296');
    });

    it('returns empty array for html with no job cards', () => {
      expect(parseRexxListing('<html><body>No jobs</body></html>')).toEqual([]);
    });

    it('deduplicates by job id', () => {
      const html = `
        <div class="joboffer_container" onclick="window.location.href='https://jobs.zfv.ch/Koechin-Koch-de-j4192.html'">
          <a href="https://jobs.zfv.ch/Koechin-Koch-de-j4192.html">Köchin/Koch</a>
        </div>
        <div class="joboffer_container" onclick="window.location.href='https://jobs.zfv.ch/Koechin-Koch-de-j4192.html'">
          <a href="https://jobs.zfv.ch/Koechin-Koch-de-j4192.html">Köchin/Koch</a>
        </div>
      `;
      expect(parseRexxListing(html)).toHaveLength(1);
    });
  });

  // ── extractJobPostingJsonLd ──
  describe('extractJobPostingJsonLd', () => {
    const jsonLdHtml = `
      <html><body>
      <script type="application/ld+json">{
        "@context": "http:\\/\\/schema.org",
        "@type": "JobPosting",
        "title": "Sous-Chef:in (80%)",
        "description": "<h2>Dein Wirkungsbereich:</h2><ul><li>Test</li></ul>",
        "datePosted": "2026-04-13",
        "validThrough": "2026-07-13",
        "employmentType": "PART_TIME",
        "hiringOrganization": { "@type": "Organization", "name": "ZFV" },
        "jobLocation": {
          "@type": "Place",
          "address": {
            "@type": "PostalAddress",
            "streetAddress": "Trüsselstrasse 2",
            "addressLocality": "Bern",
            "addressRegion": null,
            "postalCode": "3000",
            "addressCountry": "CH"
          }
        }
      }</script>
      </body></html>
    `;

    it('extracts the JobPosting object from a detail page', () => {
      const posting = extractJobPostingJsonLd(jsonLdHtml);
      expect(posting).not.toBeNull();
      expect(posting.title).toBe('Sous-Chef:in (80%)');
      expect(posting.employmentType).toBe('PART_TIME');
      expect(posting.datePosted).toBe('2026-04-13');
      expect(posting.hiringOrganization.name).toBe('ZFV');
      expect(posting.jobLocation.address.streetAddress).toBe('Trüsselstrasse 2');
      expect(posting.jobLocation.address.postalCode).toBe('3000');
    });

    it('returns null when no JSON-LD JobPosting block is present', () => {
      expect(extractJobPostingJsonLd('<html><body>no jsonld here</body></html>')).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(extractJobPostingJsonLd('')).toBeNull();
      expect(extractJobPostingJsonLd(undefined)).toBeNull();
    });

    it('skips malformed JSON-LD blocks without throwing', () => {
      const html = '<script type="application/ld+json">{ not valid json </script>';
      expect(() => extractJobPostingJsonLd(html)).not.toThrow();
      expect(extractJobPostingJsonLd(html)).toBeNull();
    });

    it('handles an @graph-wrapped JobPosting', () => {
      const html = `<script type="application/ld+json">{
        "@graph": [
          { "@type": "Organization", "name": "ZFV" },
          { "@type": "JobPosting", "title": "Gouvernante:" }
        ]
      }</script>`;
      const posting = extractJobPostingJsonLd(html);
      expect(posting?.title).toBe('Gouvernante:');
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job reflecting the ZFV-Unternehmungen crawler output
    const validJob = {
      id: 'zfv-unternehmungen-abc123def456',
      slug: 'sous-chefin-zfv-unternehmungen-bern',
      slugByLocale: { de: 'sous-chefin-zfv-unternehmungen-bern' },
      company: 'ZFV-Unternehmungen',
      companyKey: 'zfv-unternehmungen',
      companyDomain: 'zfv.ch',
      title: 'Sous-Chef:in (80%)',
      titleByLocale: { de: 'Sous-Chef:in (80%)' },
      description: 'Sous-Chef:in (80%) — ZFV-Unternehmungen, Bern. Dein Wirkungsbereich: Unterstützung bei der Führung und Organisation des gesamten Küchenbereichs.',
      descriptionByLocale: { de: 'Sous-Chef:in (80%) — ZFV-Unternehmungen, Bern. Dein Wirkungsbereich: Unterstützung bei der Führung und Organisation des gesamten Küchenbereichs.' },
      location: 'Bern',
      canton: 'BE',
      url: 'https://jobs.zfv.ch/Sous-Chefin-80-de-j4410.html',
      source: 'ZFV-Unternehmungen Dedicated Parser (rexx systems)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Bern',
      postalCode: '3000',
      streetAddress: 'Trüsselstrasse 2',
      addressRegion: 'BE',
      addressCountry: 'CH',
      employmentType: 'PART_TIME',
      sector: 'Ospitalità / Ristorazione',
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

    it('has structured-data fields required by CLAUDE.md rule #3 (safe defaults, never removed)', () => {
      // baseSalary is guaranteed downstream by build-plugins/shared/jobPostingSchema.ts
      // (per-canton default) — the crawler must not fabricate salaryMin/salaryMax,
      // but must supply the real per-job postalCode/streetAddress/jobLocation/
      // employmentType/datePosted/hiringOrganization.name inputs when available.
      expect(validJob).toHaveProperty('postalCode');
      expect(validJob).toHaveProperty('streetAddress');
      expect(validJob).toHaveProperty('addressLocality');
      expect(validJob).toHaveProperty('addressRegion');
      expect(validJob).toHaveProperty('employmentType');
      expect(validJob.company).toBe(ZFV_UNTERNEHMUNGEN_COMPANY_NAME);
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^zfv-unternehmungen-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('sector reflects the gastronomy/hospitality industry', () => {
      expect(validJob.sector).toBe('Ospitalità / Ristorazione');
    });

    it('url points to jobs.zfv.ch', () => {
      expect(validJob.url).toMatch(/^https:\/\/jobs\.zfv\.ch\//);
    });
  });
});
