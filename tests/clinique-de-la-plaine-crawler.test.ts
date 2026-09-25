import { describe, it, expect } from 'vitest';
import {
  CLINIQUE_DE_LA_PLAINE_KEY,
  CLINIQUE_DE_LA_PLAINE_COMPANY_NAME,
  isCliniqueDeLaPlaineJob,
  isTrustedDomain,
  parseListing,
  parseDetailDescription,
} from '../scripts/lib/clinique-de-la-plaine-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Clinique de la Plaine crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CLINIQUE_DE_LA_PLAINE_KEY).toBe('clinique-de-la-plaine');
    expect(CLINIQUE_DE_LA_PLAINE_COMPANY_NAME).toBe('Clinique de la Plaine');
  });

  // ── isCompanyJob ──
  describe('isCliniqueDeLaPlaineJob', () => {
    it('matches by companyKey', () => {
      expect(isCliniqueDeLaPlaineJob({ companyKey: 'clinique-de-la-plaine' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCliniqueDeLaPlaineJob({ company: 'Clinique de la Plaine' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isCliniqueDeLaPlaineJob({ url: 'https://laplaine.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCliniqueDeLaPlaineJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCliniqueDeLaPlaineJob(null)).toBe(false);
      expect(isCliniqueDeLaPlaineJob(undefined)).toBe(false);
      expect(isCliniqueDeLaPlaineJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://laplaine.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.laplaine.ch/job/456')).toBe(true);
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
      expect(slugify('Developer clinique-de-la-plaine ch')).toBe('developer-clinique-de-la-plaine-ch');
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
      id: 'clinique-de-la-plaine-abc123',
      slug: 'test-position-clinique-de-la-plaine-ch',
      slugByLocale: { fr: 'test-position-clinique-de-la-plaine-ch' },
      company: 'Clinique de la Plaine',
      companyKey: 'clinique-de-la-plaine',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://laplaine.ch/jobs/test',
      source: 'Clinique de la Plaine Dedicated Parser',
      sourceLang: 'fr',
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
      expect(validJob.id).toMatch(/^clinique-de-la-plaine-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  describe('parseListing', () => {
    const listingFixture = `
      <article class="wp-show-posts-single">
        <header class="wp-show-posts-entry-header">
          <h2 class="wp-show-posts-entry-title" itemprop="headline">
            <a href="https://laplaine.ch/emploi/une-aide-de-salle-agent-de-sterilisation-a-80-100/" rel="bookmark">Un(e) aide de salle à 80%-100%</a>
          </h2>
          <div class="wp-show-posts-entry-meta">
            <a href="https://laplaine.ch/emploi/une-aide-de-salle-agent-de-sterilisation-a-80-100/" rel="bookmark">
              <time class="wp-show-posts-entry-date published" datetime="2026-04-23T10:20:31+02:00">avril 23, 2026</time>
            </a>
          </div>
        </header>
      </article>
      <article class="wp-show-posts-single">
        <h2 class="wp-show-posts-entry-title">
          <a href="https://laplaine.ch/emploi/infirmiere-bloc-operatoire/" rel="bookmark">Infirmier(ère) bloc opératoire</a>
        </h2>
        <time class="wp-show-posts-entry-date" datetime="2026-05-01T08:00:00+02:00">mai 1, 2026</time>
      </article>
    `;

    it('extracts two unique rows with titles, URLs and posted dates', () => {
      const rows = parseListing(listingFixture);
      expect(rows).toHaveLength(2);
      expect(rows[0].url).toBe('https://laplaine.ch/emploi/une-aide-de-salle-agent-de-sterilisation-a-80-100/');
      expect(rows[0].title).toBe('Un(e) aide de salle à 80%-100%');
      expect(rows[0].postedDate).toBe('2026-04-23');
      expect(rows[1].title).toBe('Infirmier(ère) bloc opératoire');
      expect(rows[1].postedDate).toBe('2026-05-01');
    });

    it('deduplicates repeated anchors', () => {
      const dup = listingFixture + listingFixture;
      expect(parseListing(dup)).toHaveLength(2);
    });

    it('returns empty array on missing listing', () => {
      expect(parseListing('<html><body>no jobs here</body></html>')).toEqual([]);
    });
  });

  describe('parseDetailDescription', () => {
    const detailFixture = `
      <div class="et_pb_text_inner"><h1>Un(e) aide de salle à 80%-100%</h1></div>
      <div class="et_pb_text_inner">La Clinique de la Plaine est un établissement à taille humaine situé à Genève.</div>
      <div class="et_pb_text_inner"><h2>Votre mission</h2></div>
      <div class="et_pb_text_inner"><ul><li>Préparer le matériel</li><li>Assister les chirurgiens</li></ul></div>
      <div class="et_pb_text_inner"><h2>Nous offrons</h2></div>
      <div class="et_pb_text_inner">Un environnement stimulant, des horaires réglementés.</div>
    `;

    it('drops the H1 block and keeps the rest', () => {
      const text = parseDetailDescription(detailFixture);
      expect(text).not.toContain('Un(e) aide de salle à 80%-100%');
      expect(text).toContain('La Clinique de la Plaine');
      expect(text).toContain('Votre mission');
      expect(text).toContain('Préparer le matériel');
      expect(text).toContain('Nous offrons');
      expect(text).toContain('horaires réglementés');
    });

    it('returns empty string when no et_pb_text_inner blocks exist', () => {
      expect(parseDetailDescription('<div>no Divi here</div>')).toBe('');
    });

    it('caps output at ~6000 chars', () => {
      const huge = `<div class="et_pb_text_inner">${'a'.repeat(20000)}</div>`;
      expect(parseDetailDescription(huge).length).toBeLessThanOrEqual(6000);
    });
  });
});
