import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  EMMI_KEY,
  EMMI_COMPANY_NAME,
  isEmmiJob,
  isTrustedDomain,
  extractEmmiVacancyHtml,
} from '../scripts/lib/emmi-job-parser.mjs';
import { slugify, stripHtml } from '../scripts/lib/crawler-template.mjs';

describe('Emmi crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(EMMI_KEY).toBe('emmi');
    expect(EMMI_COMPANY_NAME).toBe('Emmi');
  });

  // ── isCompanyJob ──
  describe('isEmmiJob', () => {
    it('matches by companyKey', () => {
      expect(isEmmiJob({ companyKey: 'emmi' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isEmmiJob({ company: 'Emmi' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isEmmiJob({ url: 'https://emmi.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isEmmiJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEmmiJob(null)).toBe(false);
      expect(isEmmiJob(undefined)).toBe(false);
      expect(isEmmiJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://emmi.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.emmi.com/job/456')).toBe(true);
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
      expect(slugify('Developer emmi ch')).toBe('developer-emmi-ch');
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
      id: 'emmi-abc123',
      slug: 'test-position-emmi-ch',
      slugByLocale: { de: 'test-position-emmi-ch' },
      company: 'Emmi',
      companyKey: 'emmi',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://emmi.com/jobs/test',
      source: 'Emmi Dedicated Parser',
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
      expect(validJob.id).toMatch(/^emmi-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

// ── #5253: the OHWS feed carries only the two bullet lists ────────────────
describe('extractEmmiVacancyHtml', () => {
  // Real jobs.emmi.com page, minimised (three benefit cards; contact anonymised).
  const LANGNAU = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'crawler-quality-f', 'emmi-vacancy-langnau.html'),
    'utf8',
  );
  const text = stripHtml(extractEmmiVacancyHtml(LANGNAU)).replace(/[ \t]+/g, ' ');

  it('starts with the role-specific introduction', () => {
    expect(text.trim().startsWith('Wir vereinen Schweizer Tradition mit innovativer Expertise')).toBe(true);
    expect(text).toContain('Werde Teil unseres Technik-Teams im Tagesbetrieb');
  });

  it('keeps both headed lists', () => {
    expect(text).toContain('Das kannst du bewirken');
    expect(text).toContain('• Du bist verantwortlich für die Instandhaltung und -setzung von technischen Anlagen.');
    expect(text).toContain('Das bringst du mit');
    expect(text).toContain('• Du sprichst fliessend Deutsch.');
  });

  it('turns every benefit card into one list item with its title and text', () => {
    expect(text).toContain('Das bieten wir dir');
    expect(text).toContain('• Attraktive Pensionskasse mit flexiblen Sparplänen: Unsere Emmi Vorsorgestiftung');
    expect(text).toContain('• Kostenlose Parkplätze & vergünstigte Verpflegung: Wir bieten unseren Mitarbeitenden');
  });

  it('leaves the workplace, contact and similar-jobs sections out', () => {
    expect(text).not.toContain('Dein Arbeitsort');
    expect(text).not.toContain('Hast du Fragen?');
    expect(text).not.toMatch(/\+41/);
  });

  it('reads a bare benefit card without throwing (normalizeSpace is the module-level helper)', () => {
    expect(extractEmmiVacancyHtml('<section id="benefits"><div class="benefitTitle">A</div><div class="benefitText">B</div></section>'))
      .toBe('<ul><li>A: B</li></ul>');
  });

  it('returns nothing for a page without the ad sections, so the OHWS blocks are used', () => {
    expect(extractEmmiVacancyHtml('<html><body><section id="contact">x</section></body></html>')).toBe('');
  });
});
