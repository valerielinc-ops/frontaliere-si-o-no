import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSikaJobPostingDetails,
  SIKA_KEY,
  SIKA_COMPANY_NAME,
  isSikaJob,
  isTrustedDomain,
  resolveSikaListingGeography,
} from '../scripts/lib/sika-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { schemaJobLocationCandidates } from '../scripts/lib/prospector/location-evidence.mjs';

const SIKA_DETAIL_FIXTURE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sika-job-posting-details.html'),
  'utf8',
);

// Source-detail audit 2026-09-29: the parser published the listing JSON
// snippet (only "Über die Rolle", bullets flattened) — 393 of the 952 chars
// the detail page carries. The detail component is the vacancy body.
describe('parseSikaJobPostingDetails', () => {
  const text = parseSikaJobPostingDetails(SIKA_DETAIL_FIXTURE);

  it('keeps every section of the detail component with its heading', () => {
    for (const heading of ['Über die Rolle', 'Ihre Fähigkeiten und Erfahrungen', 'Warum Sie zu uns kommen sollten', 'Über Sika']) {
      expect(text).toMatch(new RegExp(`^${heading}$`, 'm'));
    }
    expect(text).toContain('Sorgfältige und strukturierte Arbeitsweise');
    expect(text).toContain('Sika ist ein global tätiges Unternehmen der Spezialitäten-Chemie');
  });

  it('keeps list items as line-start bullets and decodes non-breaking spaces', () => {
    expect(text).toMatch(/^• Einblick in die Tätigkeiten eines Entwicklungschemiker erhalten$/m);
    expect(text.split('\n').filter((line) => line.startsWith('• ')).length).toBeGreaterThanOrEqual(10);
    expect(text).not.toContain('&#xa0;');
    expect(text).not.toContain('\u00a0');
  });

  it('attaches a heading followed by an empty section to the next filled one', () => {
    expect(text).toMatch(/^Warum Sie zu uns kommen sollten\n• Unkomplizierte Führungskräfte/m);
  });

  it('stops at the component: no footer chrome, and empty for pages without it', () => {
    expect(text).not.toContain('Zugerstrasse');
    expect(parseSikaJobPostingDetails('<html><body><p>Job not found</p></body></html>')).toBe('');
  });
});

describe('Sika crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SIKA_KEY).toBe('sika');
    expect(SIKA_COMPANY_NAME).toBe('Sika');
  });

  // ── isCompanyJob ──
  describe('isSikaJob', () => {
    it('matches by companyKey', () => {
      expect(isSikaJob({ companyKey: 'sika' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSikaJob({ company: 'Sika' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSikaJob({ url: 'https://sika.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSikaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSikaJob(null)).toBe(false);
      expect(isSikaJob(undefined)).toBe(false);
      expect(isSikaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://sika.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.sika.com/job/456')).toBe(true);
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
      expect(slugify('Developer sika ch')).toBe('developer-sika-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  describe('structured location evidence', () => {
    it('blocks listing fallback when detail is explicitly foreign', () => {
      const locationCandidates = schemaJobLocationCandidates({
        address: { addressLocality: 'Geneva', addressRegion: 'NY', addressCountry: 'US' },
      });
      expect(resolveSikaListingGeography(
        { location: 'Geneva' },
        { locationCandidates },
      ).geography).toBeNull();
    });

    it('falls back to a valid listing only when detail is unresolved', () => {
      expect(resolveSikaListingGeography(
        { location: 'Baar' },
        { locationCandidates: [{ location: 'Remote', addressCountry: '' }] },
      ).geography).toMatchObject({ location: 'Baar', canton: 'ZG' });
    });

    it('preserves address metadata from the selected non-HQ Swiss candidate', () => {
      const locationCandidates = schemaJobLocationCandidates([
        { address: { addressLocality: 'Paris', addressCountry: 'FR' } },
        { address: {
          addressLocality: 'Widen', addressRegion: 'AG', addressCountry: 'CH',
          postalCode: '8967', streetAddress: 'Industriestrasse 1',
        } },
      ]);
      const decision = resolveSikaListingGeography({ location: 'Multiple locations' }, { locationCandidates });
      expect(decision.geography).toMatchObject({ location: 'Widen, AG', canton: 'AG' });
      expect(decision.candidate).toMatchObject({
        addressLocality: 'Widen', addressRegion: 'AG', postalCode: '8967', streetAddress: 'Industriestrasse 1',
      });
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'sika-abc123',
      slug: 'test-position-sika-ch',
      slugByLocale: { en: 'test-position-sika-ch' },
      company: 'Sika',
      companyKey: 'sika',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://sika.com/jobs/test',
      source: 'Sika Dedicated Parser',
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
      expect(validJob.id).toMatch(/^sika-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
