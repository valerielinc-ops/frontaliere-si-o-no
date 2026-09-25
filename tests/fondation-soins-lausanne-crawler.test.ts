import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  FONDATION_SOINS_LAUSANNE_KEY,
  FONDATION_SOINS_LAUSANNE_COMPANY_NAME,
  isFondationSoinsLausanneJob,
  isTrustedDomain,
  parseJobupSerpCards,
  filterFondationSoinsLausanneCards,
  fetchAllFondationSoinsLausanneJobs,
} from '../scripts/lib/fondation-soins-lausanne-job-parser.mjs';
import { __resetJinaBreaker } from '../scripts/lib/jina-proxy.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// Fondation Soins Lausanne (FSL) is one of AVASAD's regional home-care
// foundations, scoped to the city of Lausanne. Its former source cms-vaud.ch is
// DEAD for automated fetches (403 even through the clean-IP Jina proxy — issue
// #4168), so the crawler now reads the jobup.ch search SERP (via the Jina proxy,
// HTML return format) and parses the `data-cy="serp-item-{uuid}"` job cards.
//
// The jobup term search is relevance-ranked and surfaces OTHER employers on the
// same page — notably "Fondation de Vernand" (a DIFFERENT foundation) and the
// AVASAD umbrella. The crawler MUST keep only exact-match "Fondation Soins
// Lausanne" cards. This fixture mirrors the live markup (verified 2026-07) with a
// Vernand card + an AVASAD card that must be filtered out.

/** Build one realistic jobup SERP job card matching the live markup. */
function serpCard(opts: {
  uuid: string;
  title: string;
  employer: string;
  location: string;
  rate: string;
  contract: string;
}) {
  const { uuid, title, employer, location, rate, contract } = opts;
  return `<div><div data-cy="serp-item" class="bdr_r16"><a class="td_none d_block h_100% group" data-cy="job-link" id="vacancy-link-${uuid}" href="/fr/emplois/detail/${uuid}/" data-discover="true"><div data-cy="vacancy-serp-item-active" class="d_flex bdr_r16 flex-d_column h_100% p_s16 pos_relative"><div data-cy="serp-item-${uuid}" class="d_flex jc_space-between mb_s12"><span class="c_gray.700 d_flex gap_s8"><p class="mb_s0 textStyle_caption1">Hier</p></span></div><div class="mb_s8"><span class="c_gray.900 fw_bold textStyle_body2 wb_break-word ov_hidden">${title}</span></div><div class="d_flex c_gray.900 flex-d_column gap_s4"><div class="d_grid"><span class="pos_absolute w_1px h_1px ov_hidden">Lieu de travail<!-- -->:</span><p class="mb_s12 lastOfType:mb_s0 textStyle_caption1">${location}</p></div><div class="d_grid"><span class="pos_absolute w_1px h_1px ov_hidden">Taux d'activité<!-- -->:</span><p class="mb_s12 lastOfType:mb_s0 textStyle_caption1">${rate}</p></div><div class="d_grid"><span class="pos_absolute w_1px h_1px ov_hidden">Type de contrat<!-- -->:</span><p class="mb_s12 lastOfType:mb_s0 textStyle_caption1">${contract}</p></div></div><div class="d_grid ai_center mt_s12"><div class="avatarSquare"><picture style="height:100%"><source srcSet="https://media.jobup.ch/media/${uuid}?format=png"><img alt="" class="h_100% w_100%" src="https://media.jobup.ch/media/${uuid}?format=png"> </picture></div><p class="mb_s12 lastOfType:mb_s0 textStyle_caption1 c_gray.700 fw_bold">${employer}</p></div><div class="d_inline-flex mt_s12"><span data-cy="quick-apply" class="bdr_r16 d_inline-flex">Candidature simplifiée</span></div></div></a></div></div>`;
}

const SAMPLE_SERP_HTML = `<!doctype html><html lang="fr"><head><title>jobup.ch</title></head><body><main><div data-cy="serp-list"><h1>45 offres pour Fondation Soins Lausanne</h1>
${serpCard({ uuid: 'a0d80b13-2f2c-4262-b2ac-5a559bb9832f', title: 'Assistant en soins et santé communautaire (H/F)', employer: 'Fondation Soins Lausanne', location: 'Lausanne', rate: '60 – 80%', contract: 'Durée indéterminée' })}
${serpCard({ uuid: '93c8a1ae-ef5e-4f9d-a629-68d530736c27', title: 'Infirmiers de nuit (H/F)', employer: 'Fondation Soins Lausanne', location: 'Lausanne', rate: '100%', contract: 'Durée indéterminée' })}
${serpCard({ uuid: 'ee1ec102-1a05-4e05-90f2-9894f1af6f1f', title: 'Ergothérapeute (H/F)', employer: 'Fondation Soins Lausanne', location: 'Lausanne 10', rate: '50 – 70%', contract: 'Durée déterminée' })}
${serpCard({ uuid: '5beef050-d25f-4974-b742-bcc0ca2abbcf', title: 'Infirmier (H/F) - CDI à 80%', employer: 'Fondation de Vernand', location: 'Cheseaux-sur-Lausanne, Cheseaux-sur-Lausanne', rate: '80%', contract: 'Temporaire' })}
${serpCard({ uuid: 'ebaa64e9-9501-4977-a8d1-8fbaa3a24598', title: 'Spécialiste tarification (80 - 100%)', employer: "Association Vaudoise d'Aide et de Soins à Domicile (AVASAD)", location: 'Lausanne', rate: '80 – 100%', contract: 'Durée indéterminée' })}
${serpCard({ uuid: 'dc202cdc-3670-404f-8add-72266bffe361', title: 'Infirmier·ière-chef·fe des unités de soins', employer: 'Clinique de La Source', location: 'Lausanne', rate: '100%', contract: 'Durée indéterminée' })}
</div></main></body></html>`;

/** A jobup detail page with a rich JobPosting JSON-LD block (>50-word description). */
const JOBUP_DETAIL_HTML = `<!doctype html><html><body>
<script type="application/ld+json">{"@context":"http://schema.org/","@type":"BreadcrumbList","itemListElement":[]}</script>
<script type="application/ld+json">{
  "@context": "https://schema.org",
  "@type": "JobPosting",
  "title": "Assistant en soins et santé communautaire (H/F)",
  "description": "<p>Nos centres Médico-Sociaux (CMS) offrent à la population lausannoise des prestations pluridisciplinaires de qualité. En rejoignant la Fondation Soins Lausanne, vous vous engagez de manière concrète en faveur de la santé et du bien-vivre dans le canton de Vaud, au sein d'équipes expertes, motivées et enthousiastes. Vous dispensez des soins à domicile, accompagnez les patients dans les gestes de la vie quotidienne, collaborez avec les infirmières et participez activement à la continuité des prestations sur l'ensemble du territoire de la ville de Lausanne.</p>",
  "datePosted": "2026-06-30T15:35:35+02:00",
  "hiringOrganization": { "@type": "Organization", "name": "Association Vaudoise d'Aide et de Soins à Domicile (AVASAD)" },
  "employmentType": "Durée indéterminée",
  "jobLocation": { "@type": "Place", "address": { "@type": "PostalAddress", "streetAddress": "Route d'Oron 2", "addressRegion": "Lausanne", "postalCode": "1010", "addressCountry": "CH" } }
}</script>
</body></html>`;

describe('Fondation Soins Lausanne crawler parser (jobup.ch SERP)', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(FONDATION_SOINS_LAUSANNE_KEY).toBe('fondation-soins-lausanne');
    expect(FONDATION_SOINS_LAUSANNE_COMPANY_NAME).toBe('Fondation Soins Lausanne');
  });

  // ── SERP card parser ──
  describe('parseJobupSerpCards', () => {
    it('parses every job card with title, employer, location, rate and contract', () => {
      const cards = parseJobupSerpCards(SAMPLE_SERP_HTML);
      expect(cards).toHaveLength(6);
      expect(cards[0]).toMatchObject({
        uuid: 'a0d80b13-2f2c-4262-b2ac-5a559bb9832f',
        url: 'https://www.jobup.ch/fr/emplois/detail/a0d80b13-2f2c-4262-b2ac-5a559bb9832f/',
        title: 'Assistant en soins et santé communautaire (H/F)',
        company: 'Fondation Soins Lausanne',
        location: 'Lausanne',
        workRate: '60 – 80%',
        contract: 'Durée indéterminée',
      });
      // The Vernand card is parsed (not yet filtered here).
      expect(cards.find((c) => c.uuid === '5beef050-d25f-4974-b742-bcc0ca2abbcf')?.company).toBe(
        'Fondation de Vernand',
      );
    });

    it('returns [] for empty/no-match HTML', () => {
      expect(parseJobupSerpCards('<main></main>')).toEqual([]);
      expect(parseJobupSerpCards('')).toEqual([]);
    });
  });

  // ── STRICT employer filter ──
  describe('filterFondationSoinsLausanneCards (strict employer filter)', () => {
    it('keeps ONLY exact "Fondation Soins Lausanne" cards and drops every other employer', () => {
      const cards = parseJobupSerpCards(SAMPLE_SERP_HTML);
      const kept = filterFondationSoinsLausanneCards(cards);

      // 3 FSL cards in the fixture; 3 other employers dropped.
      expect(kept).toHaveLength(3);
      expect(kept.every((c) => c.company === 'Fondation Soins Lausanne')).toBe(true);

      // The critical requirement: "Fondation de Vernand" must be excluded, and so
      // must the AVASAD umbrella and Clinique de La Source.
      const keptEmployers = kept.map((c) => c.company);
      expect(keptEmployers).not.toContain('Fondation de Vernand');
      expect(keptEmployers).not.toContain("Association Vaudoise d'Aide et de Soins à Domicile (AVASAD)");
      expect(keptEmployers).not.toContain('Clinique de La Source');
    });

    it('is case-insensitive and trims, but never fuzzy/substring matches', () => {
      const cards = [
        { company: '  fondation soins lausanne  ', uuid: 'x', url: '', title: 'T', location: '', workRate: '', contract: '' },
        { company: 'Fondation de Vernand', uuid: 'y', url: '', title: 'T', location: '', workRate: '', contract: '' },
        { company: 'Fondation Soins Lausanne EMS', uuid: 'z', url: '', title: 'T', location: '', workRate: '', contract: '' },
      ];
      const kept = filterFondationSoinsLausanneCards(cards);
      expect(kept).toHaveLength(1);
      expect(kept[0].uuid).toBe('x');
    });

    it('handles empty/invalid input gracefully', () => {
      expect(filterFondationSoinsLausanneCards([])).toEqual([]);
      // @ts-expect-error — defensive against non-array input
      expect(filterFondationSoinsLausanneCards(null)).toEqual([]);
    });
  });

  // ── isFondationSoinsLausanneJob ──
  describe('isFondationSoinsLausanneJob', () => {
    it('matches by companyKey', () => {
      expect(isFondationSoinsLausanneJob({ companyKey: 'fondation-soins-lausanne' })).toBe(true);
    });
    it('matches by exact company name', () => {
      expect(isFondationSoinsLausanneJob({ company: 'Fondation Soins Lausanne' })).toBe(true);
    });
    it('rejects Fondation de Vernand (different employer, never fuzzy-matched)', () => {
      expect(isFondationSoinsLausanneJob({ company: 'Fondation de Vernand' })).toBe(false);
    });
    it('rejects the AVASAD umbrella', () => {
      expect(
        isFondationSoinsLausanneJob({ company: "Association Vaudoise d'Aide et de Soins à Domicile (AVASAD)" }),
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
    it('trusts jobup.ch detail/apply URLs', () => {
      expect(isTrustedDomain('https://www.jobup.ch/fr/emplois/detail/a0d80b13-2f2c-4262-b2ac-5a559bb9832f/')).toBe(true);
      expect(isTrustedDomain('https://jobup.ch/fr/emplois/')).toBe(true);
    });
    it('trusts the FSL corporate domain', () => {
      expect(isTrustedDomain('https://www.fondationsoinslausanne.ch/')).toBe(true);
    });
    it('rejects other domains and invalid URLs', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug and strips diacritics', () => {
      expect(slugify('Infirmier référent (H/F)')).toBe('infirmier-referent-h-f');
      expect(slugify('Ergothérapeute Lausanne')).toBe('ergotherapeute-lausanne');
    });
  });

  // ── fetchAllFondationSoinsLausanneJobs — end-to-end with strict filter ──
  describe('fetchAllFondationSoinsLausanneJobs', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
      process.env.JOBS_JINA_RETRY_BASE_MS = '0';
      __resetJinaBreaker();
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
      delete process.env.JOBS_JINA_RETRY_BASE_MS;
      __resetJinaBreaker();
    });

    it('fetches the jobup SERP via Jina, applies the strict filter, and enriches via jobup JSON-LD', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        // SERP is fetched through the Jina Reader proxy.
        if (u.startsWith('https://r.jina.ai/')) {
          return new Response(SAMPLE_SERP_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
        }
        // jobup.ch detail pages provide the rich JobPosting description.
        if (u.includes('jobup.ch/fr/emplois/detail/')) {
          return new Response(JOBUP_DETAIL_HTML, { status: 200 });
        }
        return new Response('', { status: 404 });
      }) as any;

      const jobs = await fetchAllFondationSoinsLausanneJobs();

      // Only the 3 exact-match FSL cards survive; Vernand/AVASAD/Clinique dropped.
      expect(jobs).toHaveLength(3);
      expect(jobs.every((j: any) => j.company === 'Fondation Soins Lausanne')).toBe(true);
      expect(jobs.some((j: any) => /vernand/i.test(j.company))).toBe(false);

      const job = jobs[0];
      expect(job).toMatchObject({
        company: 'Fondation Soins Lausanne',
        companyKey: 'fondation-soins-lausanne',
        location: 'Lausanne',
        canton: 'VD',
        postalCode: '1010',
        country: 'CH',
        addressCountry: 'CH',
      });
      expect(job.id).toMatch(/^fondation-soins-lausanne-/);
      expect(job.url).toBe('https://www.jobup.ch/fr/emplois/detail/a0d80b13-2f2c-4262-b2ac-5a559bb9832f/');
      expect(isTrustedDomain(job.url)).toBe(true);

      // Rich jobup.ch description merged in, well above the 50-word floor.
      const words = String(job.description || '').split(/\s+/).filter(Boolean).length;
      expect(words).toBeGreaterThan(50);

      // Structured-data mandatory fields (Non-Negotiable #3) all present.
      for (const f of ['postalCode', 'addressLocality', 'addressRegion', 'title', 'description', 'postedDate', 'employmentType']) {
        expect(job).toHaveProperty(f);
      }
    });

    it('falls back to a >50-word description when jobup detail enrichment fails', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith('https://r.jina.ai/')) {
          return new Response(SAMPLE_SERP_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
        }
        // Detail fetch fails — parser must still produce jobs with a rich fallback.
        return new Response('', { status: 500 });
      }) as any;

      const jobs = await fetchAllFondationSoinsLausanneJobs();
      expect(jobs).toHaveLength(3);
      const words = String(jobs[0].description || '').split(/\s+/).filter(Boolean).length;
      expect(words).toBeGreaterThan(50);
      expect(jobs[0].description).toContain('Fondation Soins Lausanne');
    });

    it('returns [] (no throw) when the Jina SERP fetch is unusable', async () => {
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith('https://r.jina.ai/')) return new Response('', { status: 502 });
        return new Response('', { status: 404 });
      }) as any;

      const jobs = await fetchAllFondationSoinsLausanneJobs();
      expect(jobs).toEqual([]);
    });

    it('returns [] when the SERP has no FSL cards (all other employers)', async () => {
      const onlyOthers = `<!doctype html><html><body><main><div data-cy="serp-list">
${serpCard({ uuid: '5beef050-d25f-4974-b742-bcc0ca2abbcf', title: 'Infirmier (H/F)', employer: 'Fondation de Vernand', location: 'Cheseaux-sur-Lausanne', rate: '80%', contract: 'Temporaire' })}
</div></main></body></html>`;
      globalThis.fetch = vi.fn(async (url: any) => {
        const u = String(url);
        if (u.startsWith('https://r.jina.ai/')) {
          return new Response(onlyOthers, { status: 200, headers: { 'content-type': 'text/html' } });
        }
        return new Response('', { status: 404 });
      }) as any;

      const jobs = await fetchAllFondationSoinsLausanneJobs();
      expect(jobs).toEqual([]);
    });
  });
});
