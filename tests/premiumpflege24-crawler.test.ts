import { describe, it, expect } from 'vitest';
import {
  PREMIUMPFLEGE24_KEY,
  PREMIUMPFLEGE24_COMPANY_NAME,
  extractPremiumpflege24NationwideApplicationListing,
  isPremiumpflege24Job,
  isTrustedDomain,
  resolvePremiumpflege24Geography,
  shouldUsePremiumpflege24NationwideFallback,
} from '../scripts/lib/premiumpflege24-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const NATIONWIDE_APPLICATION_PAGE = `
  <html>
    <head><title>Jobs in der Seniorenbetreuung - PremiumPflege24</title></head>
    <body>
      <header>PremiumPflege24</header>
      <main class="content">
        <h1>Jobs</h1>
        <section>
          <h2>Ihre Zukunft in der Seniorenbetreuung in der Schweiz</h2>
          <p>Jobs in der ganzen Schweiz: PremiumPflege24 sucht engagierte Betreuungskräfte
            für die Seniorenbetreuung und Haushaltshilfe bei Menschen, die Unterstützung
            im Alltag benötigen. Die Einsätze können als 24-Stunden-Betreuung,
            stundenweise Begleitung oder Ferienbegleitung organisiert werden. Wir bieten
            faire Bedingungen, eine herzliche Teamkultur und sinnvolle Aufgaben mit
            direktem Kontakt zu unseren Kundinnen und Kunden.</p>
          <p>Ihre Bewerbung ist willkommen. Bewerben Sie sich über das Formular und
            teilen Sie uns Ihre Erfahrung, Ihre gewünschte Einsatzart und Ihre
            Verfügbarkeit mit. Unser Team begleitet den Bewerbungsprozess persönlich
            und klärt gemeinsam mit Ihnen, welcher Einsatz in der ganzen Schweiz passt.</p>
        </section>
        <form><label>Name</label><input name="name" /></form>
      </main>
      <footer>PremiumPflege24 GmbH, Gewerbestrasse 2, 4553 Subingen</footer>
    </body>
  </html>
`;

describe('PremiumPflege24 GmbH crawler parser', () => {
  describe('nationwide application-page fallback', () => {
    it('rechecks the seed when JSON-LD exposes only a thin teaser', () => {
      expect(shouldUsePremiumpflege24NationwideFallback([
        { description: 'Entdecken Sie erfüllende Jobs bei PremiumPflege24.' },
      ])).toBe(true);
    });

    it('keeps a publishable spec row authoritative', () => {
      expect(shouldUsePremiumpflege24NationwideFallback([
        { description: NATIONWIDE_APPLICATION_PAGE },
      ])).toBe(false);
    });

    it('keeps a rich nationwide source page without fabricating the HQ canton', () => {
      const listing = extractPremiumpflege24NationwideApplicationListing(
        NATIONWIDE_APPLICATION_PAGE,
        'https://premiumpflege24.ch/job-registrierung/',
      );

      expect(listing).toMatchObject({
        title: 'Jobs in der Seniorenbetreuung - PremiumPflege24',
        url: 'https://premiumpflege24.ch/job-registrierung/',
        location: 'Schweiz',
        addressLocality: 'Schweiz',
        addressCountry: 'CH',
        nationwide: true,
      });
      expect(listing.description.split(/\s+/).length).toBeGreaterThanOrEqual(50);
      expect(resolvePremiumpflege24Geography(listing)).toEqual({
        location: 'Schweiz',
        canton: '',
      });
    });

    it('rejects a generic page without the source-backed role and scope signals', () => {
      expect(extractPremiumpflege24NationwideApplicationListing(
        '<html><head><title>Jobs</title></head><body><main><h1>Jobs</h1><p>Kontaktieren Sie uns.</p></main></body></html>',
        'https://premiumpflege24.ch/job-registrierung/',
      )).toBeNull();
    });

    it('keeps normal canton-specific rows on the shared geography resolver', () => {
      expect(resolvePremiumpflege24Geography({
        location: 'Lugano',
        addressCountry: 'CH',
      })).toEqual({ location: 'Lugano', canton: 'TI', addressCountry: 'CH' });
    });
  });

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(PREMIUMPFLEGE24_KEY).toBe('premiumpflege24');
    expect(PREMIUMPFLEGE24_COMPANY_NAME).toBe('PremiumPflege24 GmbH');
  });

  // ── isCompanyJob ──
  describe('isPremiumpflege24Job', () => {
    it('matches by companyKey', () => {
      expect(isPremiumpflege24Job({ companyKey: 'premiumpflege24' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isPremiumpflege24Job({ company: 'PremiumPflege24 GmbH' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isPremiumpflege24Job({ url: 'https://premiumpflege24.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isPremiumpflege24Job({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isPremiumpflege24Job(null)).toBe(false);
      expect(isPremiumpflege24Job(undefined)).toBe(false);
      expect(isPremiumpflege24Job({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://premiumpflege24.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.premiumpflege24.ch/job/456')).toBe(true);
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
      expect(slugify('Developer premiumpflege24 ch')).toBe('developer-premiumpflege24-ch');
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
      id: 'premiumpflege24-abc123',
      slug: 'test-position-premiumpflege24-ch',
      slugByLocale: { de: 'test-position-premiumpflege24-ch' },
      company: 'PremiumPflege24 GmbH',
      companyKey: 'premiumpflege24',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://premiumpflege24.ch/jobs/test',
      source: 'PremiumPflege24 GmbH Dedicated Parser',
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
      expect(validJob.id).toMatch(/^premiumpflege24-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
