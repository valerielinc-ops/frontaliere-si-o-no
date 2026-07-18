import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  RHNE_KEY,
  RHNE_COMPANY_NAME,
  RHNE_COMPANY_DOMAIN,
  isRhneJob,
  isTrustedDomain,
  parseRhneListing,
  fetchRhneJobDetail,
  fetchAllRhneJobs,
} from '../scripts/lib/rhne-reseau-hospitalier-neuchatelois-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// ── Fixtures ──────────────────────────────────────────────────────────────

const LISTING_HTML = `
  <div id="jobs">
    <a href="/espace-emploi/emploi/postuler/tous-les-postes?jobId=2567328&amp;cat=all" class="jobLink">
      Infirmier·ère chef·fe d'unité de soins à 80-100 %
    </a>
    <a href="/espace-emploi/emploi/postuler/tous-les-postes?jobId=2566921&amp;cat=all" class="jobLink">
      Médecin chef·fe adjoint·e à 80-100%
    </a>
    <a href="/espace-emploi/emploi/postuler/tous-les-postes?jobId=2567328&amp;cat=all" class="jobLink">
      Infirmier·ère chef·fe d'unité de soins à 80-100 % (dup)
    </a>
  </div>
`;

/**
 * Realistic RHNE detail-page fixture. Deliberately includes several DECOY
 * `class="portlet-body"` containers (nav / search / breadcrumb portlets, as
 * seen on the real live page) BEFORE the real jobup portlet section, to
 * regression-guard the bug where the parser grabbed the first (wrong,
 * near-empty) portlet-body instead of scoping to the jobup portlet.
 */
function detailHtml({
  title = "Infirmier·ère chef·fe d'unité de soins à 80-100 %",
  location = '2000 Neuchâtel',
  datePosted = '17.07.2026',
  applyId = 'f3f0220a-d1c5-43b2-9fa2-665889ba36dc',
  missions = "<li>Diriger et encadrer une équipe</li><li>Garantir la qualité des soins</li>",
} = {}) {
  const decoyPortlets = Array.from({ length: 4 }, (_, i) => `
    <section class="portlet" id="portlet_decoy_${i}">
      <div class="portlet-content"><div class="portlet-content-container">
        <div class="portlet-body"></div>
      </div></div>
    </section>
  `).join('\n');

  return `
    <!doctype html><html><body>
    <nav class="top-menu"><div class="portlet-body">nav search widget</div></nav>
    ${decoyPortlets}
    <div class="lfr-layout-structure-item-rhne-web-jobup-rhnewebjobupportlet">
      <div class="portlet-boundary portlet-boundary_rhne_web_jobup_RHNeWebJobupPortlet_" id="p_p_id_rhne_web_jobup_RHNeWebJobupPortlet_INSTANCE_tauj_">
        <section class="portlet" id="portlet_rhne_web_jobup_RHNeWebJobupPortlet_INSTANCE_tauj">
          <div class="portlet-content"><div class="portlet-content-container"><div class="portlet-body">
            <div style="font-weight: 500 !important">L'unité accueille les patient·e·s 24h/24 et 7j/7.</div>
            <h1 class="titlepage">${title}</h1> <span> </span><br> <span>Lieu de travail : ${location}</span>
            <p class="date">Date de publication: ${datePosted}</p>
            <div style="text-align: justify">
              <p><strong>Vos missions</strong></p>
              <ul>${missions}</ul>
              <p><strong>Votre profil</strong></p>
              <ul><li>Bachelor HES-SO en soins infirmiers</li><li>Expérience de 3 ans minimum</li></ul>
              <p><strong>Vos compétences</strong></p>
              <ul><li>Leadership</li><li>Sens des priorités</li></ul>
              <p><strong>Informations complémentaires</strong></p>
              <ul><li>Lieu de travail : site de Pourtalès, Neuchâtel</li><li>Entrée en fonction : à convenir</li></ul>
            </div>
            <button id="backButton" class="btnrhne"><a href="?cat=all">Retour</a></button>
            <button id="applyButton" class="btnrhne">
              <a target="_blank" href="https://www.jobup.ch/fr/application/create/${applyId}">Postuler</a>
            </button>
            <small>Le RHNe utilise JobUp pour collecter vos données.</small>
          </div></div></div>
        </section>
      </div>
    </div>
    </body></html>
  `;
}

function urlFor(jobId: string) {
  return `https://www.rhne.ch/espace-emploi/emploi/postuler/tous-les-postes?jobId=${jobId}&cat=all`;
}

const LISTING_URL = 'https://www.rhne.ch/espace-emploi/emploi/postuler/tous-les-postes?cat=all';

function mockFetch(handlers: Record<string, string>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
    const url = String(input);
    for (const [key, html] of Object.entries(handlers)) {
      if (url.includes(key)) {
        return { ok: true, status: 200, text: async () => html } as unknown as Response;
      }
    }
    return { ok: false, status: 404, text: async () => 'not found' } as unknown as Response;
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('RHNE (Réseau hospitalier neuchâtelois) crawler parser', () => {
  it('exports valid company key, name and domain', () => {
    expect(RHNE_KEY).toBe('rhne-reseau-hospitalier-neuchatelois');
    expect(RHNE_COMPANY_NAME).toContain('Réseau hospitalier neuchâtelois');
    expect(RHNE_COMPANY_DOMAIN).toBe('rhne.ch');
  });

  describe('isRhneJob', () => {
    it('matches by companyKey', () => {
      expect(isRhneJob({ companyKey: 'rhne-reseau-hospitalier-neuchatelois' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isRhneJob({ url: 'https://www.rhne.ch/espace-emploi/emploi/postuler/tous-les-postes?jobId=1' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRhneJob({ companyKey: 'other', url: 'https://example.com' })).toBe(false);
    });
  });

  describe('isTrustedDomain', () => {
    it('trusts the primary domain', () => {
      expect(isTrustedDomain('https://www.rhne.ch/espace-emploi/emploi/postuler/tous-les-postes')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('parseRhneListing', () => {
    it('extracts jobId, title and url from jobLink anchors', () => {
      const items = parseRhneListing(LISTING_HTML);
      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({
        jobId: '2567328',
        title: "Infirmier·ère chef·fe d'unité de soins à 80-100 %",
        url: urlFor('2567328'),
      });
      expect(items[1].jobId).toBe('2566921');
    });

    it('deduplicates repeated jobIds', () => {
      const items = parseRhneListing(LISTING_HTML);
      expect(items.filter((i) => i.jobId === '2567328')).toHaveLength(1);
    });

    it('returns an empty array when no jobLink anchors are present', () => {
      expect(parseRhneListing('<div id="jobs"></div>')).toEqual([]);
    });
  });

  describe('fetchRhneJobDetail (live-verified: plain unauthenticated GET, no session cookie)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('scopes extraction to the jobup portlet, skipping decoy portlet-body containers', async () => {
      mockFetch({ [urlFor('2567328')]: detailHtml() });
      const detail = await fetchRhneJobDetail(urlFor('2567328'));
      expect(detail).not.toBeNull();
      expect(detail.title).toBe("Infirmier·ère chef·fe d'unité de soins à 80-100 %");
      expect(detail.body).not.toContain('nav search widget');
    });

    it('extracts location, ISO postedDate and the jobup.ch apply link', async () => {
      mockFetch({ [urlFor('2566921')]: detailHtml({ location: '2400 Le Locle', datePosted: '9.7.2026', applyId: '04e52545-432d-426f-8008-99d12759beb7' }) });
      const detail = await fetchRhneJobDetail(urlFor('2566921'));
      expect(detail.location).toBe('2400 Le Locle');
      expect(detail.datePosted).toBe('2026-07-09');
      expect(detail.applyUrl).toBe('https://www.jobup.ch/fr/application/create/04e52545-432d-426f-8008-99d12759beb7');
    });

    it('includes the rich Vos missions / Votre profil body content', async () => {
      mockFetch({ [urlFor('2567328')]: detailHtml() });
      const detail = await fetchRhneJobDetail(urlFor('2567328'));
      expect(detail.body).toContain('Diriger et encadrer une équipe');
      expect(detail.body).toContain('Bachelor HES-SO');
      expect(detail.body).toContain('Leadership');
    });

    it('returns null when the jobup portlet section is absent (markup drift)', async () => {
      mockFetch({ [urlFor('9999999')]: '<html><body>no jobup portlet here</body></html>' });
      const detail = await fetchRhneJobDetail(urlFor('9999999'));
      expect(detail).toBeNull();
    });
  });

  describe('fetchAllRhneJobs (listing + per-job detail-page fetch)', () => {
    beforeEach(() => {
      process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
    });

    afterEach(() => {
      vi.restoreAllMocks();
      delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
    });

    it('produces real, non-empty job listings with rich descriptions (not the pre-auth empty-shell fallback)', async () => {
      mockFetch({
        [LISTING_URL]: LISTING_HTML,
        [urlFor('2567328')]: detailHtml(),
        [urlFor('2566921')]: detailHtml({
          title: 'Médecin chef·fe adjoint·e à 80-100%',
          location: '2400 Le Locle',
          datePosted: '16.07.2026',
          applyId: '04e52545-432d-426f-8008-99d12759beb7',
        }),
      });

      const jobs = await fetchAllRhneJobs();
      expect(jobs).toHaveLength(2);

      const j = jobs[0];
      expect(j.title).toBe("Infirmier·ère chef·fe d'unité de soins à 80-100 %");
      expect(j.location).toBe('Neuchâtel');
      expect(j.postalCode).toBe('2000');
      expect(j.canton).toBe('NE');
      expect(j.postedDate).toBe('2026-07-17');
      expect(j.applyUrl).toBe('https://www.jobup.ch/fr/application/create/f3f0220a-d1c5-43b2-9fa2-665889ba36dc');
      expect(j.url).toBe(urlFor('2567328'));
      expect(j.sourceLang).toBe('fr');
      expect(j.description.split(/\s+/).length).toBeGreaterThan(50);
      expect(j.description).toMatch(/Diriger et encadrer/);
      expect(j.descriptionByLocale.fr).toBe(j.description);
      expect(j.slugByLocale).toEqual({ fr: j.slug });
      expect(j.id).toMatch(/^rhne-reseau-hospitalier-neuchatelois-/);
      expect(j.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);

      const second = jobs[1];
      expect(second.location).toBe('Le Locle');
      expect(second.postalCode).toBe('2400');
      expect(second.postedDate).toBe('2026-07-16');
    });

    it('falls back to the brand-blurb description when a single detail fetch fails, without dropping the job or the batch', async () => {
      mockFetch({ [LISTING_URL]: LISTING_HTML, [urlFor('2566921')]: detailHtml() });
      // urlFor('2567328') has no handler -> mockFetch returns a 404, which
      // fetchHtml()'s retry wrapper surfaces as a thrown error.
      const jobs = await fetchAllRhneJobs();
      expect(jobs).toHaveLength(2);

      const failed = jobs.find((j: { url: string }) => j.url === urlFor('2567328'));
      expect(failed).toBeDefined();
      expect(failed.description).toMatch(/Réseau hospitalier neuchâtelois/);
      expect(failed.description.split(/\s+/).length).toBeGreaterThan(20);

      const ok = jobs.find((j: { url: string }) => j.url === urlFor('2566921'));
      expect(ok.description).toMatch(/Diriger et encadrer/);
    });

    it('returns [] (no throw) when the listing page has no jobLink anchors', async () => {
      mockFetch({ [LISTING_URL]: '<div id="jobs"></div>' });
      const jobs = await fetchAllRhneJobs();
      expect(jobs).toEqual([]);
    });

    it('detects FULL_TIME employmentType from a high occupation percentage in the title', async () => {
      mockFetch({ [LISTING_URL]: LISTING_HTML, [urlFor('2567328')]: detailHtml(), [urlFor('2566921')]: detailHtml() });
      const jobs = await fetchAllRhneJobs();
      expect(jobs[0].employmentType).toBe('FULL_TIME');
      expect(jobs[0].contract).toBe('full-time');
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      expect(slugify("Infirmier·ère chef·fe d'unité")).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
