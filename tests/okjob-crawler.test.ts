import { describe, it, expect } from 'vitest';
import {
  OKJOB_KEY,
  OKJOB_COMPANY_NAME,
  extractOkjobDetailFields,
  isOkjobJob,
  isTrustedDomain,
} from '../scripts/lib/okjob-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('OK Job SA, succursale di Mendrisio crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(OKJOB_KEY).toBe('okjob');
    expect(OKJOB_COMPANY_NAME).toBe('OK Job SA, succursale di Mendrisio');
  });

  // ── isCompanyJob ──
  describe('isOkjobJob', () => {
    it('matches by companyKey', () => {
      expect(isOkjobJob({ companyKey: 'okjob' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isOkjobJob({ company: 'OK Job SA, succursale di Mendrisio' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isOkjobJob({ url: 'https://okjob.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isOkjobJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isOkjobJob(null)).toBe(false);
      expect(isOkjobJob(undefined)).toBe(false);
      expect(isOkjobJob({})).toBe(false);
    });
  });

  // ── extractOkjobDetailFields ──
  describe('extractOkjobDetailFields', () => {
    const detailPage = (title: string) => `<!doctype html><html><head><title>${title}</title>`
      + `<meta property="og:title" content="${title}"></head>`
      + '<body><h1>Mécatronicien automobile</h1><p>Mandaté par un de nos clients nous recherchons '
      + 'un mécatronicien automobile expérimenté pour un poste fixe. Vous assurez le diagnostic, '
      + "l'entretien et la réparation des véhicules de la clientèle de notre partenaire.</p></body></html>";

    it('deriva il comune dal titolo di marca della pagina di dettaglio', () => {
      // Unica evidenza di localita' sul dettaglio okjob: senza, il gate
      // geografico scartava ogni riga e il crawler pubblicava zero annunci.
      const detail = extractOkjobDetailFields(
        detailPage('Emploi Mécatronicien automobile - Yverdon-les-Bains | Okjob'),
        'https://www.okjob.ch/offres-demplois/mecatronicien-automobile-yverdon-les-bains/?ref=41867',
      );
      expect(detail.location).toBe('Yverdon-les-Bains');
      expect(detail.addressLocality).toBe('Yverdon-les-Bains');
      expect(detail.locationCandidates).toEqual([
        { location: 'Yverdon-les-Bains', addressLocality: 'Yverdon-les-Bains', addressCountry: '' },
      ]);
    });

    it('legge anche il prefisso tedesco dello stesso schema', () => {
      const detail = extractOkjobDetailFields(
        detailPage('Stellenangebote Leitung Pflege - Zurich | Okjob'),
        'https://www.okjob.ch/de/jobangebote/leitung-pflege-zuerich/?ref=41880',
      );
      expect(detail.location).toBe('Zurich');
    });

    it('non inventa una localita\' senza il suffisso di marca', () => {
      // Un titolo qualunque contiene un trattino: senza `| Okjob` la coda non
      // e' evidenza di niente e la riga deve restare senza geografia.
      const detail = extractOkjobDetailFields(
        detailPage('Offre - Postulez maintenant'),
        'https://www.okjob.ch/offres-demplois/offre/',
      );
      expect(detail.location).toBeFalsy();
      expect(detail.locationCandidates ?? []).toHaveLength(0);
    });

    it('non sovrascrive una localita\' gia\' estratta dalla pagina', () => {
      const html = '<!doctype html><html><head><title>Emploi Test - Yverdon-les-Bains | Okjob</title>'
        + '</head><body><script type="application/ld+json">'
        + JSON.stringify({
          '@type': 'JobPosting',
          title: 'Test',
          description: 'Une description de poste suffisamment longue pour passer le seuil du gate.',
          jobLocation: { address: { addressLocality: 'Neuchâtel', addressCountry: 'CH' } },
        })
        + '</script></body></html>';
      const detail = extractOkjobDetailFields(html, 'https://www.okjob.ch/offres-demplois/test/');
      expect(detail.location).not.toBe('Yverdon-les-Bains');
    });

    it('gestisce un HTML vuoto senza rompersi', () => {
      expect(() => extractOkjobDetailFields('', 'https://www.okjob.ch/offres-demplois/x/')).not.toThrow();
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://okjob.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.okjob.ch/job/456')).toBe(true);
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
      expect(slugify('Developer okjob ch')).toBe('developer-okjob-ch');
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
      id: 'okjob-abc123',
      slug: 'test-position-okjob-ch',
      slugByLocale: { fr: 'test-position-okjob-ch' },
      company: 'OK Job SA, succursale di Mendrisio',
      companyKey: 'okjob',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://okjob.ch/jobs/test',
      source: 'OK Job SA, succursale di Mendrisio Dedicated Parser',
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
      expect(validJob.id).toMatch(/^okjob-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
