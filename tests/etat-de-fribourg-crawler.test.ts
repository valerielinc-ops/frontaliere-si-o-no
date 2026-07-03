import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ETAT_DE_FRIBOURG_KEY,
  ETAT_DE_FRIBOURG_COMPANY_NAME,
  isEtatDeFribourgJob,
  isTrustedDomain,
  fetchAllEtatDeFribourgJobs,
} from '../scripts/lib/etat-de-fribourg-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Etat de Fribourg crawler parser', () => {
  // -- Constants --
  it('exports valid company key and name', () => {
    expect(ETAT_DE_FRIBOURG_KEY).toBe('etat-de-fribourg');
    expect(ETAT_DE_FRIBOURG_COMPANY_NAME).toBe('Etat de Fribourg');
  });

  // -- isCompanyJob --
  describe('isEtatDeFribourgJob', () => {
    it('matches by companyKey', () => {
      expect(isEtatDeFribourgJob({ companyKey: 'etat-de-fribourg' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isEtatDeFribourgJob({ company: 'Etat de Fribourg' })).toBe(true);
    });

    it('matches by jobs.fr.ch URL', () => {
      expect(isEtatDeFribourgJob({ url: 'https://jobs.fr.ch/job/Fribourg%2C-CH-Sample/1234567/' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isEtatDeFribourgJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('rejects Fribourg hospital entities (distinct employers)', () => {
      expect(isEtatDeFribourgJob({ companyKey: 'hfr-hopital-fribourgeois', company: 'HFR' })).toBe(false);
      expect(isEtatDeFribourgJob({ companyKey: 'rfsm-fribourg', company: 'RFSM' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEtatDeFribourgJob(null)).toBe(false);
      expect(isEtatDeFribourgJob(undefined)).toBe(false);
      expect(isEtatDeFribourgJob({})).toBe(false);
    });
  });

  // -- isTrustedDomain --
  describe('isTrustedDomain', () => {
    it('trusts jobs.fr.ch (ATS platform)', () => {
      expect(isTrustedDomain('https://jobs.fr.ch/job/Fribourg%2C-CH-Sample/1234567/')).toBe(true);
    });

    it('trusts fr.ch primary domain', () => {
      expect(isTrustedDomain('https://www.fr.ch/emploi')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('rejects domains containing fr.ch as substring', () => {
      expect(isTrustedDomain('https://notfr.ch/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // -- slugify (imported from crawler-template) --
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Collaborateur administratif (h/f)');
      expect(slug).toBe('collaborateur-administratif-h-f');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Juriste etat-de-fribourg ch')).toBe('juriste-etat-de-fribourg-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // -- Job Shape Validation --
  describe('job shape', () => {
    const validJob = {
      id: 'etat-de-fribourg-abc123def456',
      slug: 'juriste-etat-de-fribourg-ch',
      slugByLocale: { fr: 'juriste-etat-de-fribourg-ch' },
      company: 'Etat de Fribourg',
      companyKey: 'etat-de-fribourg',
      companyDomain: 'fr.ch',
      title: 'Juriste',
      titleByLocale: { fr: 'Juriste' },
      description: 'Juriste -- Etat de Fribourg. Service: Direction de la sécurité, de la justice et du sport. Lieu de travail: Fribourg (FR)',
      descriptionByLocale: { fr: 'Juriste -- Etat de Fribourg. Service: Direction de la sécurité, de la justice et du sport. Lieu de travail: Fribourg (FR)' },
      location: 'Fribourg',
      canton: 'FR',
      url: 'https://jobs.fr.ch/job/Fribourg%2C-CH-Juriste/1234567/',
      source: 'Etat de Fribourg Dedicated Parser',
      sourceLang: 'fr',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Fribourg',
      postalCode: '1700',
      addressCountry: 'CH',
      country: 'CH',
      category: 'Giuridico',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: 'mid',
      sector: 'Amministrazione Pubblica',
      currency: 'CHF',
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

    it('has all recommended fields', () => {
      const recommended = [
        'addressLocality', 'postalCode', 'addressCountry', 'country',
        'category', 'contract', 'employmentType', 'experienceLevel',
        'sector', 'currency',
      ];
      for (const field of recommended) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^etat-de-fribourg-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('description has minimum 30 chars', () => {
      expect(validJob.description.length).toBeGreaterThanOrEqual(30);
    });

    it('sector is Amministrazione Pubblica', () => {
      expect(validJob.sector).toBe('Amministrazione Pubblica');
    });

    it('URL points to jobs.fr.ch detail page', () => {
      expect(validJob.url).toContain('jobs.fr.ch/job/');
    });
  });

  // ── fetchAllEtatDeFribourgJobs (graceful degradation + live parsing) ──
  describe('fetchAllEtatDeFribourgJobs', () => {
    const realFetch = globalThis.fetch;

    const listingHtml = `<html lang="fr-FR"><body><ul>
      <li class="job-tile job-id-1365607057 job-row-index-0" data-url="/job/Fribourg%2C-CH-Juriste-Sari/1365607057/" data-row-index="0">
        <div class="job-tile-cell">
          <div class="tiletitle">
            <a class="jobTitle-link fontcolorb6a533a1" href="/job/Fribourg%2C-CH-Juriste-Sari/1365607057/">Juriste</a>
          </div>
          <div id="job-1365607057-desktop-section-city-value">Fribourg, CH</div>
          <div id="job-1365607057-desktop-section-shifttype-value">80-100%</div>
          <div id="job-1365607057-desktop-section-dept-value">Direction de la sécurité, de la justice et du sport</div>
        </div>
      </li>
    </ul></body></html>`;

    const detailHtml = `<html lang="fr-FR"><head><title>Juriste</title></head><body>
      <span data-careersite-propertyid="title">Juriste</span>
      <div data-careersite-propertyid="description">
        <p>Le Secrétariat général de la Direction de la sécurité, de la justice et du sport recherche un-e juriste
        pour renforcer son équipe. Vous serez chargé-e du traitement de dossiers juridiques complexes, de la
        rédaction d'avis de droit, et du conseil aux autorités cantonales sur des questions législatives variées.
        Une formation universitaire complète en droit suisse est requise, ainsi qu'une bonne connaissance de
        l'administration publique. Nous offrons des conditions de travail attractives, une bonne conciliation
        entre vie professionnelle et vie privée, ainsi que des perspectives de formation continue au sein de
        l'Etat de Fribourg.</p>
      </div>
      <span itemprop="jobLocation" itemscope itemtype="http://schema.org/Place">
        <span itemprop="address" itemscope itemtype="http://schema.org/PostalAddress">
          <meta itemprop="addressLocality" content="Fribourg, CH">
          <meta itemprop="addressRegion" content="Saane">
          <meta itemprop="addressCountry" content="CH">
        </span>
      </span>
      <meta itemprop="datePosted" content="Thu Jul 02 00:00:00 UTC 2026">
      <meta itemprop="validThrough" content="Fri Jul 17 22:00:00 UTC 2026">
      <meta itemprop="hiringOrganization" content="Etat de Fribourg - Staat Freiburg">
      <a href="/talentcommunity/apply/1365607057/?locale=fr_FR">Postuler</a>
    </body></html>`;

    beforeEach(() => {
      process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
      process.env.JOBS_CRAWLER_DELAY_MS = '0';
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
      delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
      delete process.env.JOBS_CRAWLER_DELAY_MS;
    });

    it('returns [] (no throw) on total network failure', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('ENOTFOUND jobs.fr.ch');
      }) as any;

      const jobs = await fetchAllEtatDeFribourgJobs();
      expect(jobs).toEqual([]);
    });

    it('returns [] (no throw) when the listing page errors', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response('', { status: 500 });
      }) as any;

      const jobs = await fetchAllEtatDeFribourgJobs();
      expect(jobs).toEqual([]);
    });

    it('parses a listing tile + detail page into a valid job object', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.includes('/search/?startrow=0')) return new Response(listingHtml, { status: 200 });
        if (u.includes('/search/?startrow=')) return new Response('<html><body><ul></ul></html>', { status: 200 });
        if (u.includes('/job/Fribourg%2C-CH-Juriste-Sari/1365607057/')) return new Response(detailHtml, { status: 200 });
        return new Response('', { status: 404 });
      }) as any;

      const jobs = await fetchAllEtatDeFribourgJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        company: 'Etat de Fribourg',
        companyKey: 'etat-de-fribourg',
        title: 'Juriste',
        location: 'Fribourg',
        canton: 'FR',
        country: 'CH',
        addressCountry: 'CH',
        sourceLang: 'fr',
        sector: 'Amministrazione Pubblica',
        department: 'Direction de la sécurité, de la justice et du sport',
      });
      expect(jobs[0].id).toMatch(/^etat-de-fribourg-/);
      expect(isTrustedDomain(jobs[0].url)).toBe(true);
    });

    it('description clears the 50-word thin-content floor', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.includes('/search/?startrow=0')) return new Response(listingHtml, { status: 200 });
        if (u.includes('/search/?startrow=')) return new Response('<html><body><ul></ul></html>', { status: 200 });
        if (u.includes('/job/Fribourg%2C-CH-Juriste-Sari/1365607057/')) return new Response(detailHtml, { status: 200 });
        return new Response('', { status: 404 });
      }) as any;

      const jobs = await fetchAllEtatDeFribourgJobs();
      const words = String(jobs[0].description || '').split(/\s+/).filter(Boolean).length;
      expect(words).toBeGreaterThanOrEqual(50);
    });

    it('derives 80-100% pensum into FULL_TIME employmentType and full-time contract', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.includes('/search/?startrow=0')) return new Response(listingHtml, { status: 200 });
        if (u.includes('/search/?startrow=')) return new Response('<html><body><ul></ul></html>', { status: 200 });
        if (u.includes('/job/Fribourg%2C-CH-Juriste-Sari/1365607057/')) return new Response(detailHtml, { status: 200 });
        return new Response('', { status: 404 });
      }) as any;

      const jobs = await fetchAllEtatDeFribourgJobs();
      expect(jobs[0].employmentType).toBe('FULL_TIME');
      expect(jobs[0].contract).toBe('full-time');
      expect(jobs[0].pensumMin).toBe(80);
      expect(jobs[0].pensumMax).toBe(100);
    });
  });
});
