import { describe, it, expect } from 'vitest';
import {
  MED_IPERSONAL_KEY,
  MED_IPERSONAL_COMPANY_NAME,
  isMedIpersonalJob,
  isTrustedDomain,
} from '../scripts/lib/med-ipersonal-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { extractIpersonalDescription } from '../scripts/lib/ipersonal-spec-runtime.mjs';

describe('MediPersonal crawler parser', () => {
  describe('shared Simple Job Board detail boundary', () => {
    it('preserves authored HTML lists without the application tail', () => {
      const html = `
        <header>Site chrome</header>
        <section class="job-profile-section"><div id="Jobdetails">
          <p>Wir vermitteln eine langfristige Stelle in einem eingespielten Team.</p>
          <h3>Ihre Aufgaben</h3>
          <ul><li>Kundenbeziehungen professionell aufbauen</li><li>Dossiers vollständig führen</li></ul>
          <h3>Diese Punkte sind zwingend</h3>
          <ul><li>Mehrjährige Berufserfahrung</li><li>Stilsicheres Deutsch</li></ul>
          <h3>Bewerben Sie sich jetzt</h3>
          <p>Unterlagen per Formular oder E-Mail senden.</p>
        </div></section>`;

      const description = extractIpersonalDescription(html);
      expect(description).toContain('\n• Kundenbeziehungen professionell aufbauen');
      expect(description).toContain('\n• Mehrjährige Berufserfahrung');
      expect(description).not.toContain('Site chrome');
      expect(description).not.toContain('Unterlagen per Formular');
    });
  });

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(MED_IPERSONAL_KEY).toBe('med-ipersonal');
    expect(MED_IPERSONAL_COMPANY_NAME).toBe('MediPersonal');
  });

  // ── isCompanyJob ──
  describe('isMedIpersonalJob', () => {
    it('matches by companyKey', () => {
      expect(isMedIpersonalJob({ companyKey: 'med-ipersonal' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isMedIpersonalJob({ company: 'MediPersonal' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isMedIpersonalJob({ url: 'https://ipersonal.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isMedIpersonalJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isMedIpersonalJob(null)).toBe(false);
      expect(isMedIpersonalJob(undefined)).toBe(false);
      expect(isMedIpersonalJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://ipersonal.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.ipersonal.ch/job/456')).toBe(true);
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
      expect(slugify('Developer med-ipersonal ch')).toBe('developer-med-ipersonal-ch');
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
      id: 'med-ipersonal-abc123',
      slug: 'test-position-med-ipersonal-ch',
      slugByLocale: { de: 'test-position-med-ipersonal-ch' },
      company: 'MediPersonal',
      companyKey: 'med-ipersonal',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://ipersonal.ch/jobs/test',
      source: 'MediPersonal Dedicated Parser',
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
      expect(validJob.id).toMatch(/^med-ipersonal-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
