import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  SRG_SSR_KEY,
  SRG_SSR_COMPANY_NAME,
  isSrgSsrJob,
  isTrustedDomain,
  extractSrgSsrRenderedDescription,
  detectSrgSsrBodyLanguage,
  resolveSrgSsrSourceLang,
  prepareSrgSsrExistingJobs,
  srgSsrBenefitsText,
} from '../scripts/lib/srg-ssr-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('SRG SSR crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SRG_SSR_KEY).toBe('srg-ssr');
    expect(SRG_SSR_COMPANY_NAME).toBe('SRG SSR');
  });

  // ── isCompanyJob ──
  describe('isSrgSsrJob', () => {
    it('matches by companyKey', () => {
      expect(isSrgSsrJob({ companyKey: 'srg-ssr' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSrgSsrJob({ company: 'SRG SSR' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSrgSsrJob({ url: 'https://srgssr.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSrgSsrJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSrgSsrJob(null)).toBe(false);
      expect(isSrgSsrJob(undefined)).toBe(false);
      expect(isSrgSsrJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://srgssr.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.srgssr.ch/job/456')).toBe(true);
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
      expect(slugify('Developer srg-ssr ch')).toBe('developer-srg-ssr-ch');
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
      id: 'srg-ssr-abc123',
      slug: 'test-position-srg-ssr-ch',
      slugByLocale: { de: 'test-position-srg-ssr-ch' },
      company: 'SRG SSR',
      companyKey: 'srg-ssr',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://srgssr.ch/jobs/test',
      source: 'SRG SSR Dedicated Parser',
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
      expect(validJob.id).toMatch(/^srg-ssr-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── Rendered description (issue 5253) ──
  describe('extractSrgSsrRenderedDescription', () => {
    // Minimised RTR detail page (contact names/phones redacted). Its JSON-LD
    // `description` carries tasks + profile + a contact stub only: the
    // introduction and the «Per infurmaziun» block exist only in the markup.
    const html = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'srg-ssr', 'rtr-fufragnadi-detail.html'),
      'utf8',
    );
    const text = extractSrgSsrRenderedDescription(html);

    it('keeps the introduction and every specification block the page renders', () => {
      expect(text).toMatch(/^RTR è in'unitad d'interpresa da la SRG SSR/);
      expect(text).toContain('## Tge èn las pussaivladads?');
      expect(text).toContain('## Tge èn nossas spetgas?');
      expect(text).toContain('## Per infurmaziun');
      expect(text).toContain("RTR porscha mintg'onn ina plazza d'emprendissadi commerziala");
    });

    it('keeps the line structure of the source instead of one flat paragraph', () => {
      expect(text).toContain('Ti discurras in idiom rumantsch e sas era scriver rumantsch\nTi has almain');
    });

    it('closes with the offer block, each benefit once (not again from the SVG tooltip)', () => {
      expect(text).toMatch(/\n## Nossa purschida\nTge dovri per cuntanscher/);
      for (const title of ['Far medias', 'Concepir la digitalisaziun', 'Esser uman', 'Crear senn']) {
        expect(text).toContain(`\n- ${title}: `);
      }
      expect(text.match(/Schurnalissem da qualitad è nossa fatschenta principala/g)).toHaveLength(1);
      expect(text.indexOf('## Nossa purschida')).toBeGreaterThan(text.indexOf('## Per infurmaziun'));
    });

    it('reads no benefits from a page without the offer section', () => {
      expect(srgSsrBenefitsText('<section id="introduction"><p>x</p></section>')).toBe('');
    });

    it('leaves out contact, slogan quote and other sections', () => {
      expect(text).not.toMatch(/Persuna da contact|resursas umanas|\+41/);
      expect(text).not.toContain('In fufragnadi tar RTR porscha sguards');
    });

    it('keeps a benefits-only detail page', () => {
      const html = '<section id="benefits"><h2>Offer</h2><div class="teaser">T</div><p class="benefit-1 content">B</p></section>';
      const benefitsOnly = extractSrgSsrRenderedDescription(html);

      expect(benefitsOnly).toContain('## Offer');
      expect(benefitsOnly).toContain('T');
      expect(benefitsOnly).toContain('B');
    });

    it('returns an empty string when the template sections are absent', () => {
      expect(extractSrgSsrRenderedDescription('<html><body><h1>x</h1></body></html>')).toBe('');
    });
  });

  describe('RTR source-language mapping', () => {
    const html = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'srg-ssr', 'rtr-fufragnadi-detail.html'),
      'utf8',
    );
    const romanshBody = extractSrgSsrRenderedDescription(html);

    it('detects Romansh from the body, never from the title', () => {
      expect(detectSrgSsrBodyLanguage(romanshBody)).toBe('rm');
    });

    it('prefers a same-ID German sibling when the source exposes one', () => {
      expect(resolveSrgSsrSourceLang({
        description: romanshBody,
        localizedDescriptions: { de: 'Wir suchen eine Lernperson für RTR.' },
      })).toBe('de');
    });

    it('keeps a genuine Italian RSI body in Italian, including a Romansh mention', () => {
      const italianBody = 'La RSI è un servizio pubblico da Lugano. '
        + 'Il ruolo collabora con la redazione italiana e tratta anche il termine rumantsch. '
        + 'Le attività si svolgono in un team editoriale e richiedono precisione.';
      expect(detectSrgSsrBodyLanguage(italianBody)).toBe('it');
    });

    it('does not classify Italian, French, or German broadcaster prose as Romansh', () => {
      const falsePositives = [
        'La RSI è un partner da anni del progetto LAS dedicato al rumantsch.',
        'La RSI presenta il nuovo progetto editoriale e ne racconta gli obiettivi al pubblico.',
        'La RTS présente ses offres et explique les prochaines étapes aux personnes intéressées.',
        'Das SRF informiert über das Projekt und beschreibt die nächsten Schritte für das Team.',
      ];

      for (const body of falsePositives) {
        expect(detectSrgSsrBodyLanguage(body)).not.toBe('rm');
      }
    });

    it('requires corroboration for a distinctive Romansh marker', () => {
      expect(detectSrgSsrBodyLanguage("L'infurmaziun è da far cun ils candidats.", 'de')).toBe('rm');
    });

    it('repairs historical RTR copies without changing published slugs', () => {
      const historical = {
        id: 'srg-ssr-rtr-rm-1',
        url: 'https://jobs.srgssr.ch/rtr/offene-stellen/fufragnadi/abc',
        slug: 'fufragnadi-srg-ssr-cuira',
        title: 'Fufragnadi',
        description: romanshBody,
        sourceLang: 'it',
        titleByLocale: {
          it: 'Fufragnadi',
          en: 'Fufragnadi',
          de: 'Fufragnadi',
          fr: 'Fufragnadi',
        },
        descriptionByLocale: {
          it: romanshBody,
          en: romanshBody,
          de: romanshBody,
          fr: romanshBody,
        },
        slugByLocale: {
          it: 'fufragnadi-it',
          en: 'fufragnadi-en',
          de: 'fufragnadi-de',
          fr: 'fufragnadi-fr',
        },
      };

      const [repaired] = prepareSrgSsrExistingJobs([historical]);
      expect(repaired.sourceLang).toBe('rm');
      expect(repaired.sourceLangOriginal).toBe('rm');
      expect(repaired.needsRetranslation).toBe(true);
      expect(Object.keys(repaired.titleByLocale)).toEqual(['rm']);
      expect(Object.keys(repaired.descriptionByLocale)).toEqual(['rm']);
      expect(repaired.descriptionByLocale.rm).toBe(romanshBody);
      expect(repaired.slug).toBe(historical.slug);
      expect(repaired.slugByLocale).toMatchObject(historical.slugByLocale);
    });
  });
});
