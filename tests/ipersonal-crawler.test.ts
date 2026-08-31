import { describe, it, expect } from 'vitest';
import {
  IPERSONAL_KEY,
  IPERSONAL_COMPANY_NAME,
  isIpersonalJob,
  isTrustedDomain,
} from '../scripts/lib/ipersonal-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import {
  extractIpersonalDescription,
  runIpersonalSpecInProduction,
} from '../scripts/lib/ipersonal-spec-runtime.mjs';

describe('iPersonal AG crawler parser', () => {
  describe('shared Simple Job Board detail boundary', () => {
    it('preserves legacy arrow lists and stops before application boilerplate', () => {
      const html = `
        <nav>Navigation noise</nav>
        <section class="job-profile-section"><div id="Jobdetails">
          <h2>Dipl. Pflegefachperson Spiez</h2>
          <p>Du betreust Patientinnen und Patienten in einem professionellen Pflegeteam.</p>
          <h3>Deine Aufgaben</h3>
          <p>› Pflege planen und dokumentieren› Angehörige kompetent beraten</p>
          <h3>Kontakt und Bewerbung</h3>
          <p>Lebenslauf hochladen und info@example.test kontaktieren.</p>
        </div></section>
        <form id="sjb-application-form">Formularfelder</form>`;

      const description = extractIpersonalDescription(html);
      expect(description).toContain('\n• Pflege planen und dokumentieren');
      expect(description).toContain('\n• Angehörige kompetent beraten');
      expect(description).not.toContain('Navigation noise');
      expect(description).not.toContain('Lebenslauf hochladen');
      expect(description).not.toContain('Formularfelder');
    });

    it('fails closed when the authoritative detail boundary is absent', () => {
      expect(extractIpersonalDescription('<main><p>Generic page copy</p></main>')).toBe('');
    });

    it('keeps nested legacy content and recovers paragraph-backed lists', () => {
      const html = `
        <section class="job-profile-section"><div id="Jobdetails"><div>
          <p>Wir suchen eine erfahrene Fachperson für einen langfristigen Einsatz.</p>
          <h3>Deine Aufgaben</h3>
          <p>Patientinnen und Patienten fachgerecht betreuen und dokumentieren.</p>
          <p>Das interdisziplinäre Team im Alltag zuverlässig unterstützen.</p>
          <h3>Jetzt bewerben</h3><p>Wiederholter Bewerbungstext.</p>
        </div><p>Keyword- und Kontakttail.</p></div></section>`;

      const description = extractIpersonalDescription(html);
      expect(description).toContain('\n• Patientinnen und Patienten');
      expect(description).toContain('\n• Das interdisziplinäre Team');
      expect(description).not.toContain('Wiederholter Bewerbungstext');
      expect(description).not.toContain('Keyword- und Kontakttail');
    });

    it('requests identity encoding and stays idempotent on the shared runtime', async () => {
      const seedUrl = 'https://ipersonal-fixture.example/';
      const detailUrl = `${seedUrl}jobs/pflegefachperson-zuerich/`;
      const acceptedEncodings: string[] = [];
      const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
        acceptedEncodings.push(new Headers(init.headers).get('Accept-Encoding') || '');
        const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.endsWith('/robots.txt')) return new Response('', { status: 200 });
        if (url === seedUrl) {
          return new Response(`<a href="${detailUrl}">Pflegefachperson Zürich</a>`, {
            status: 200, headers: { 'Content-Type': 'text/html' },
          });
        }
        return new Response(`
          <script type="application/ld+json">${JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'JobPosting',
            title: 'Pflegefachperson Zürich',
            url: detailUrl,
            description: 'Eine langfristige Aufgabe in einem professionellen Team mit persönlicher Begleitung und klarer fachlicher Verantwortung im Pflegealltag.',
            jobLocation: {
              '@type': 'Place',
              address: { '@type': 'PostalAddress', addressLocality: 'Zürich', addressRegion: 'ZH', addressCountry: 'CH' },
            },
          })}</script>
          <section class="job-profile-section"><div id="Jobdetails">
            <p>Eine langfristige Aufgabe in einem professionellen Team mit persönlicher Begleitung und klarer fachlicher Verantwortung im Pflegealltag.</p>
            <h3>Deine Aufgaben</h3><ul><li>Patientinnen kompetent betreuen</li><li>Pflege sorgfältig dokumentieren</li></ul>
          </div></section>`, { status: 200, headers: { 'Content-Type': 'text/html' } });
      };
      const spec = {
        companyKey: 'ipersonal', companyName: 'iPersonal AG', platform: 'med-ipersonal.ch',
        seedUrls: [seedUrl], mode: 'template', detailTemplate: '/jobs/*/', detailFetchWorkers: 1,
      } as any;
      const runtime = {
        fetchImpl: fetchImpl as typeof fetch,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => undefined,
        retries: 0,
      };

      const first = await runIpersonalSpecInProduction(spec, runtime);
      const second = await runIpersonalSpecInProduction(spec, runtime);
      expect(second).toEqual(first);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        title: 'Pflegefachperson Zürich', url: detailUrl, canton: 'ZH',
      });
      expect(first[0].description).toContain('\n• Patientinnen kompetent betreuen');
      expect(acceptedEncodings.length).toBeGreaterThan(0);
      expect(acceptedEncodings.every((value) => value === 'identity')).toBe(true);
    });
  });

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(IPERSONAL_KEY).toBe('ipersonal');
    expect(IPERSONAL_COMPANY_NAME).toBe('iPersonal AG');
  });

  // ── isCompanyJob ──
  describe('isIpersonalJob', () => {
    it('matches by companyKey', () => {
      expect(isIpersonalJob({ companyKey: 'ipersonal' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isIpersonalJob({ company: 'iPersonal AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isIpersonalJob({ url: 'https://med-ipersonal.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isIpersonalJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isIpersonalJob(null)).toBe(false);
      expect(isIpersonalJob(undefined)).toBe(false);
      expect(isIpersonalJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://med-ipersonal.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.med-ipersonal.ch/job/456')).toBe(true);
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
      expect(slugify('Developer ipersonal ch')).toBe('developer-ipersonal-ch');
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
      id: 'ipersonal-abc123',
      slug: 'test-position-ipersonal-ch',
      slugByLocale: { de: 'test-position-ipersonal-ch' },
      company: 'iPersonal AG',
      companyKey: 'ipersonal',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://med-ipersonal.ch/jobs/test',
      source: 'iPersonal AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^ipersonal-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
