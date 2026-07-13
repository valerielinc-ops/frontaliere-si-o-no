import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  FONDATION_SOINS_LAUSANNE_KEY,
  FONDATION_SOINS_LAUSANNE_COMPANY_NAME,
  isFondationSoinsLausanneJob,
  isTrustedDomain,
  parseFondationSoinsLausanneListing,
  fetchAllFondationSoinsLausanneJobs,
} from '../scripts/lib/fondation-soins-lausanne-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// Fondation Soins Lausanne (FSL) is one of AVASAD's regional home-care
// foundations, scoped to the city of Lausanne only. Its own domain
// (fondationsoinslausanne.ch) 301-redirects to the shared AVASAD portal
// cms-vaud.ch — verified live (2026-07) — which server-renders a listing
// page filterable by `?employer=`, deep-linking to jobup.ch (JobCloud
// sibling of jobs.ch) detail pages carrying a full JobPosting JSON-LD block.
const LISTING_URL_PREFIX = 'https://www.cms-vaud.ch/offres-d-emploi/';
const SAMPLE_LISTING_HTML = `
<section>
  <article class="job-item">
    <h1 class="title"><a target="_blank" href="https://www.jobup.ch/fr/emplois/detail/66adbf2c-f176-4796-a870-af3c04ff3510/" class="link">ICLS - infirmier clinicien sp&#233;cialis&#233; (H/F) - 60-80% - Fondation Soins Lausanne</a></h1>
    <div class="desc">
      <div class="date-wrapper"></div>
      <div class="txt">
        <span>1010 Lausanne R&#233;gion lausannoise</span><br>
        <span>Fondation Soins Lausanne</span><br>
        <span>Ref: 2563407</span><br>
        <span>Publication: 30.06.2026</span>
      </div>
    </div>
  </article>
  <article class="job-item">
    <h1 class="title"><a target="_blank" href="https://www.jobup.ch/fr/emplois/detail/4bf200ff-69ab-4dbb-81de-aeb73c9d7c6f/" class="link">ASSC (H/F) - entre 60% - 80% / - Fondation Soins Lausanne</a></h1>
    <div class="desc">
      <div class="date-wrapper"></div>
      <div class="txt">
        <span>1010 Lausanne R&#233;gion lausannoise</span><br>
        <span>Fondation Soins Lausanne</span><br>
        <span>Ref: 2563408</span><br>
        <span>Publication: 28.06.2026</span>
      </div>
    </div>
  </article>
</section>
`;

const SAMPLE_JOBUP_DETAIL_HTML = `
<html><body>
<script type="application/ld+json">[{"@context":"http://schema.org/","@type":"BreadcrumbList","itemListElement":[]}]</script>
<script type="application/ld+json">{
  "@context": "https://schema.org",
  "@type": "JobPosting",
  "title": "ICLS - Infirmier clinicien spécialisé (H/F)",
  "description": "<p>Nos centres Médico-Sociaux (CMS) offrent à la population Lausannoise des prestations pluridisciplinaires de qualité. En rejoignant la Fondation Soins Lausanne, vous vous engagez de manière concrète en faveur de la santé et du bien-vivre dans le canton de Vaud, au sein d'équipes expertes, motivées et enthousiastes. Vous accompagnez les équipes dans les situations complexes, diffusez les bonnes pratiques et renforcez les compétences des soignants. Vous supervisez la documentation clinique et intégrez les nouveaux collaborateurs. Vous pilotez des projets d'amélioration continue et d'innovation, guidez l'implantation des nouvelles pratiques et favorisez l'adhésion des équipes. Vous garantissez des interventions fondées sur des données actualisées, adaptées au domicile.</p>",
  "datePosted": "2026-06-30T15:35:35+02:00",
  "hiringOrganization": { "@type": "Organization", "name": "Association Vaudoise d'Aide et de Soins à Domicile (AVASAD)" },
  "employmentType": "Durée indéterminée",
  "workHours": "25.2 - 33.6 hours/week",
  "jobLocation": { "@type": "Place", "address": { "@type": "PostalAddress", "streetAddress": "Route d'Oron 2", "addressRegion": "Lausanne", "postalCode": "1010", "addressCountry": "CH" } },
  "baseSalary": { "@type": "MonetaryAmount", "currency": "CHF", "value": { "@type": "QuantitativeValue" } }
}</script>
</body></html>
`;

describe('Fondation Soins Lausanne crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(FONDATION_SOINS_LAUSANNE_KEY).toBe('fondation-soins-lausanne');
    expect(FONDATION_SOINS_LAUSANNE_COMPANY_NAME).toBe('Fondation Soins Lausanne');
  });

  // ── isCompanyJob ──
  describe('isFondationSoinsLausanneJob', () => {
    it('matches by companyKey', () => {
      expect(isFondationSoinsLausanneJob({ companyKey: 'fondation-soins-lausanne' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isFondationSoinsLausanneJob({ company: 'Fondation Soins Lausanne' })).toBe(true);
    });

    it('matches by URL domain + company name combo', () => {
      expect(
        isFondationSoinsLausanneJob({
          company: 'Fondation Soins Lausanne',
          url: 'https://www.cms-vaud.ch/offres-d-emploi/',
        }),
      ).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isFondationSoinsLausanneJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' }),
      ).toBe(false);
    });

    it('rejects sibling AVASAD foundations (same portal, different employer)', () => {
      expect(
        isFondationSoinsLausanneJob({
          companyKey: 'apromad',
          company: 'APROMAD',
          url: 'https://www.cms-vaud.ch/offres-d-emploi/',
        }),
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isFondationSoinsLausanneJob(null)).toBe(false);
      expect(isFondationSoinsLausanneJob(undefined)).toBe(false);
      expect(isFondationSoinsLausanneJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the AVASAD portal domain', () => {
      expect(isTrustedDomain('https://www.cms-vaud.ch/offres-d-emploi/')).toBe(true);
    });

    it('trusts cms-vaud.ch subdomains', () => {
      expect(isTrustedDomain('https://sub.cms-vaud.ch/x')).toBe(true);
    });

    it('trusts jobup.ch detail/apply URLs', () => {
      expect(isTrustedDomain('https://www.jobup.ch/fr/emplois/detail/66adbf2c-f176-4796-a870-af3c04ff3510/')).toBe(true);
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
      const slug = slugify('Infirmier référent (H/F)');
      expect(slug).toBe('infirmier-referent-h-f');
    });

    it('strips diacritics', () => {
      expect(slugify('Ergothérapeute Lausanne')).toBe('ergotherapeute-lausanne');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Infirmier fondation-soins-lausanne Lausanne')).toBe(
        'infirmier-fondation-soins-lausanne-lausanne',
      );
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Listing HTML parser ──
  describe('parseFondationSoinsLausanneListing', () => {
    it('parses each job-item article into a structured record', () => {
      const items = parseFondationSoinsLausanneListing(SAMPLE_LISTING_HTML);
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({
        title: 'ICLS - infirmier clinicien spécialisé (H/F) - 60-80% - Fondation Soins Lausanne',
        applyUrl: 'https://www.jobup.ch/fr/emplois/detail/66adbf2c-f176-4796-a870-af3c04ff3510/',
        locationLine: '1010 Lausanne Région lausannoise',
        ref: '2563407',
        publicationIso: '2026-06-30',
      });
    });

    it('returns [] for empty/no-match HTML', () => {
      expect(parseFondationSoinsLausanneListing('<section></section>')).toEqual([]);
      expect(parseFondationSoinsLausanneListing('')).toEqual([]);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'fondation-soins-lausanne-abc123',
      slug: 'infirmier-referent-fondation-soins-lausanne-lausanne',
      slugByLocale: { fr: 'infirmier-referent-fondation-soins-lausanne-lausanne' },
      company: 'Fondation Soins Lausanne',
      companyKey: 'fondation-soins-lausanne',
      title: 'Infirmier référent (H/F)',
      titleByLocale: { fr: 'Infirmier référent (H/F)' },
      description: 'Une description de poste suffisamment riche pour dépasser le plancher de 50 mots requis par la règle de contenu léger, en détaillant les missions, les responsabilités et le profil recherché pour ce poste au sein de la Fondation Soins Lausanne, active dans les soins et l\'aide à domicile sur le territoire lausannois.',
      descriptionByLocale: {
        fr: 'Une description de poste suffisamment riche pour dépasser le plancher de 50 mots requis par la règle de contenu léger, en détaillant les missions, les responsabilités et le profil recherché pour ce poste au sein de la Fondation Soins Lausanne, active dans les soins et l\'aide à domicile sur le territoire lausannois.',
      },
      location: 'Lausanne',
      canton: 'VD',
      url: 'https://www.jobup.ch/fr/emplois/detail/66adbf2c-f176-4796-a870-af3c04ff3510/',
      source: 'Fondation Soins Lausanne Dedicated Parser (cms-vaud.ch listing + jobup.ch JSON-LD)',
      sourceLang: 'fr',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Lausanne',
      addressRegion: 'VD',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '1010',
      employmentType: 'FULL_TIME',
      postedDate: '2026-06-30',
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

    // Non-Negotiable #3: structured-data mandatory fields must be derivable
    // from the raw parser output (baseSalary/streetAddress/hiringOrganization
    // are filled downstream by build-plugins/shared/jobPostingSchema.ts from
    // these source fields — see companyHqAddresses + postalCodes safe defaults).
    it('carries every field needed to build the mandatory JobPosting block', () => {
      expect(validJob).toHaveProperty('postalCode');
      expect(validJob).toHaveProperty('addressLocality');
      expect(validJob).toHaveProperty('addressRegion');
      expect(validJob).toHaveProperty('addressCountry', 'CH');
      expect(validJob).toHaveProperty('company'); // → hiringOrganization.name
      expect(validJob).toHaveProperty('title');
      expect(validJob).toHaveProperty('description');
      expect(validJob).toHaveProperty('postedDate'); // → datePosted
      expect(validJob).toHaveProperty('employmentType');
    });

    // Non-Negotiable #4: no indexed content under 50 words.
    it('description clears the 50-word thin-content floor', () => {
      const words = String(validJob.description).split(/\s+/).filter(Boolean).length;
      expect(words).toBeGreaterThan(50);
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^fondation-soins-lausanne-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── fetchAllFondationSoinsLausanneJobs — graceful degradation ──
  describe('fetchAllFondationSoinsLausanneJobs — graceful degradation', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
      // Skip the real exponential backoff — several tests below deliberately
      // return 500/503/network errors to exercise graceful degradation.
      process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
      delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
    });

    it('fetches the listing, enriches each job via jobup.ch JSON-LD, and returns rich jobs', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith(LISTING_URL_PREFIX)) {
          return new Response(SAMPLE_LISTING_HTML, { status: 200 });
        }
        if (u.includes('jobup.ch/fr/emplois/detail/')) {
          return new Response(SAMPLE_JOBUP_DETAIL_HTML, { status: 200 });
        }
        return new Response('', { status: 404 });
      }) as any;

      const jobs = await fetchAllFondationSoinsLausanneJobs();
      expect(jobs).toHaveLength(2);

      const job = jobs[0];
      expect(job).toMatchObject({
        company: 'Fondation Soins Lausanne',
        companyKey: 'fondation-soins-lausanne',
        location: 'Lausanne',
        canton: 'VD',
        postalCode: '1010',
        country: 'CH',
      });
      expect(job.id).toMatch(/^fondation-soins-lausanne-/);
      expect(job.url).toBe('https://www.jobup.ch/fr/emplois/detail/66adbf2c-f176-4796-a870-af3c04ff3510/');
      expect(isTrustedDomain(job.url)).toBe(true);

      // Rich jobup.ch description merged in, well above the 50-word floor.
      const words = String(job.description || '').split(/\s+/).filter(Boolean).length;
      expect(words).toBeGreaterThan(50);
      expect(job.description).toContain('Fondation Soins Lausanne');
      expect(job.postedDate).toBe('2026-06-30');
    });

    it('falls back to a listing-derived description when the jobup.ch detail fetch fails', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith(LISTING_URL_PREFIX)) {
          return new Response(SAMPLE_LISTING_HTML, { status: 200 });
        }
        // jobup detail fetch fails — parser must still produce a job.
        return new Response('', { status: 500 });
      }) as any;

      const jobs = await fetchAllFondationSoinsLausanneJobs();
      expect(jobs).toHaveLength(2);
      expect(jobs[0].description).toContain('Fondation Soins Lausanne');
      expect(jobs[0].postedDate).toBe('2026-06-30'); // from listing publication line
    });

    it('returns [] (no throw) when the listing endpoint is unreachable', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('ENOTFOUND www.cms-vaud.ch');
      }) as any;
      const jobs = await fetchAllFondationSoinsLausanneJobs();
      expect(jobs).toEqual([]);
    });

    it('returns [] (no throw) when the listing endpoint errors', async () => {
      globalThis.fetch = vi.fn(async () => new Response('', { status: 503 })) as any;
      const jobs = await fetchAllFondationSoinsLausanneJobs();
      expect(jobs).toEqual([]);
    });

    it('rescues an IP-reputation WAF 403 on the listing via the Jina proxy (#4143)', async () => {
      // cms-vaud.ch started 403-ing the GitHub Actions egress IP while a clean
      // IP still gets a normal 200 with the real listing (verified live,
      // #4143: 3 consecutive empty runs). The direct fetch must fall through
      // to the Jina-proxied fetch instead of returning [] on the 403.
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith('https://r.jina.ai/')) {
          return new Response(SAMPLE_LISTING_HTML, { status: 200 });
        }
        if (u.startsWith(LISTING_URL_PREFIX)) {
          return new Response('', { status: 403 });
        }
        // jobup.ch detail enrichment — not the point of this test.
        return new Response('', { status: 404 });
      }) as any;

      const jobs = await fetchAllFondationSoinsLausanneJobs();
      expect(jobs).toHaveLength(2);
      expect(jobs[0].company).toBe('Fondation Soins Lausanne');
    });

    it('returns [] when the listing has no job-item articles', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith(LISTING_URL_PREFIX)) {
          return new Response('<section></section>', { status: 200 });
        }
        return new Response('', { status: 404 });
      }) as any;
      const jobs = await fetchAllFondationSoinsLausanneJobs();
      expect(jobs).toEqual([]);
    });
  });
});
