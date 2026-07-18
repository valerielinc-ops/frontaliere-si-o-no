import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  TRIAPLUS_KEY,
  TRIAPLUS_COMPANY_NAME,
  TRIAPLUS_COMPANY_DOMAIN,
  isTriaplusJob,
  isTrustedDomain,
  parseListingPage,
  parseJobLocation,
  fetchAllTriaplusJobs,
} from '../scripts/lib/triaplus-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// ── Fixtures ────────────────────────────────────────────────────────────

const LISTING_URL = 'https://karriere.triaplus.ch/freie-stellen/';

const LISTING_HTML = `
  <a href="https://karriere.triaplus.ch/jobs/assistenzaerztin-oder-fachaerztin-w-m-d-ambulant/">Assistenzärztin</a>
  <a href="https://karriere.triaplus.ch/jobs/sozialarbeiter-in-w-m-d/">Sozialarbeiter/in</a>
  <a href="https://karriere.triaplus.ch/jobs/assistenzaerztin-oder-fachaerztin-w-m-d-ambulant/">dup</a>
`;

/**
 * Realistic Triaplus detail-page fixture, modelled on the live markup
 * (confirmed 2026-07 against https://karriere.triaplus.ch/jobs/... — issue
 * #4418): the job title block renders
 * `<span class="ort">in  <City>[ (<CANTON>)]</span>` right after the H2,
 * BEFORE the H3 body sections. `ortSpan` lets tests override/omit it to
 * cover the markup-missing fallback path.
 */
function detailHtml({
  title = 'Assistenzärztin oder Fachärztin (w/m/d) ambulant',
  ortSpan = '<span class="ort">in  Pfäffikon (SZ)</span><span class="prozent">, 80 – 100%',
} = {}) {
  return `<!doctype html><html><head><title>${title} | Triaplus AG</title></head><body>
    <div class="section titel">
      <h2 class="has-d-3-font-size jobtitel">${title} <br>
        ${ortSpan}</h2>
    </div>
    <h3>Ihre Aufgaben beinhalten</h3>
    <ul>
      <li>Ambulante und teilstationäre Betreuung von Patientinnen und Patienten</li>
      <li>Interdisziplinäre Zusammenarbeit im Behandlungsteam</li>
    </ul>
    <h3>Sie bringen dafür mit</h3>
    <ul>
      <li>Abgeschlossenes Studium der Humanmedizin</li>
      <li>Freude an der Arbeit mit psychisch erkrankten Menschen</li>
    </ul>
    <div class="cta-content">apply widget</div>
  </body></html>`;
}

function urlFor(slug: string) {
  return `https://karriere.triaplus.ch/jobs/${slug}/`;
}

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

// ── Tests ───────────────────────────────────────────────────────────────

describe('Triaplus AG crawler parser', () => {
  it('exports valid company key, name and domain', () => {
    expect(TRIAPLUS_KEY).toBe('triaplus');
    expect(TRIAPLUS_COMPANY_NAME).toBe('Triaplus AG');
    expect(TRIAPLUS_COMPANY_DOMAIN).toBe('triaplus.ch');
  });

  describe('isTriaplusJob', () => {
    it('matches by companyKey', () => {
      expect(isTriaplusJob({ companyKey: 'triaplus' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isTriaplusJob({ url: urlFor('some-job') })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isTriaplusJob({ companyKey: 'other', url: 'https://example.com' })).toBe(false);
    });
  });

  describe('isTrustedDomain', () => {
    it('trusts the primary domain', () => {
      expect(isTrustedDomain(urlFor('some-job'))).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('parseListingPage', () => {
    it('extracts and dedupes /jobs/{slug}/ hrefs', () => {
      const urls = parseListingPage(LISTING_HTML);
      expect(urls).toHaveLength(2);
      expect(urls).toContain(urlFor('assistenzaerztin-oder-fachaerztin-w-m-d-ambulant'));
      expect(urls).toContain(urlFor('sozialarbeiter-in-w-m-d'));
    });

    it('returns an empty array when no job hrefs are present', () => {
      expect(parseListingPage('<html><body>no jobs</body></html>')).toEqual([]);
    });
  });

  // Issue #4418: the crawler used to hardcode DEFAULT_CITY ('Oberwil') for
  // every single job regardless of which of Triaplus's real sites (Uri,
  // Schwyz, Zug cantons) it was actually posted at. parseJobLocation reads
  // the REAL per-job `<span class="ort">` the site itself renders.
  describe('parseJobLocation', () => {
    it('resolves a known city with an explicit canton in the span (Pfäffikon (SZ))', () => {
      const loc = parseJobLocation(detailHtml({ ortSpan: '<span class="ort">in  Pfäffikon (SZ)</span>' }));
      expect(loc).toEqual({ city: 'Pfäffikon', canton: 'SZ', postalCode: '8808' });
    });

    it('resolves a known city with no canton in the span (Oberwil-Zug -> head-clinic default city)', () => {
      const loc = parseJobLocation(detailHtml({ ortSpan: '<span class="ort">in  Oberwil-Zug</span>' }));
      expect(loc).toEqual({ city: 'Oberwil', canton: 'ZG', postalCode: '6317' });
    });

    it('resolves other known outpatient sites across all three cantons (not just Oberwil)', () => {
      expect(parseJobLocation(detailHtml({ ortSpan: '<span class="ort">in  Baar</span>' })))
        .toEqual({ city: 'Baar', canton: 'ZG', postalCode: '6340' });
      expect(parseJobLocation(detailHtml({ ortSpan: '<span class="ort">in  Altdorf</span>' })))
        .toEqual({ city: 'Altdorf', canton: 'UR', postalCode: '6460' });
      expect(parseJobLocation(detailHtml({ ortSpan: '<span class="ort">in  Goldau</span>' })))
        .toEqual({ city: 'Goldau', canton: 'SZ', postalCode: '6410' });
      expect(parseJobLocation(detailHtml({ ortSpan: '<span class="ort">in  Einsiedeln</span>' })))
        .toEqual({ city: 'Einsiedeln', canton: 'SZ', postalCode: '8840' });
      expect(parseJobLocation(detailHtml({ ortSpan: '<span class="ort">in  Steinen</span>' })))
        .toEqual({ city: 'Steinen', canton: 'SZ', postalCode: '6422' });
    });

    it('falls back to a best-effort record for an unrecognised city that does carry a canton', () => {
      const loc = parseJobLocation(detailHtml({ ortSpan: '<span class="ort">in  Neuestadt (SZ)</span>' }));
      expect(loc).toEqual({ city: 'Neuestadt', canton: 'SZ', postalCode: '6317' });
    });

    it('returns null when the ort span is missing (markup drift) so the caller can fall back to DEFAULT_CITY', () => {
      expect(parseJobLocation('<html><body>no ort span here</body></html>')).toBeNull();
    });
  });

  describe('fetchAllTriaplusJobs (listing + per-job detail-page fetch)', () => {
    beforeEach(() => {
      process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
    });

    afterEach(() => {
      vi.restoreAllMocks();
      delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
    });

    it('assigns REAL, varied per-job locations instead of the same hardcoded city for every job', async () => {
      mockFetch({
        [LISTING_URL]: LISTING_HTML,
        [urlFor('assistenzaerztin-oder-fachaerztin-w-m-d-ambulant')]: detailHtml({
          title: 'Assistenzärztin oder Fachärztin (w/m/d) ambulant',
          ortSpan: '<span class="ort">in  Pfäffikon (SZ)</span>',
        }),
        [urlFor('sozialarbeiter-in-w-m-d')]: detailHtml({
          title: 'Sozialarbeiter/in (w/m/d)',
          ortSpan: '<span class="ort">in  Baar</span>',
        }),
      });

      const jobs = await fetchAllTriaplusJobs();
      expect(jobs).toHaveLength(2);

      const szJob = jobs.find((j: { title: string }) => j.title.startsWith('Assistenzärztin'));
      expect(szJob.location).toBe('Pfäffikon');
      expect(szJob.canton).toBe('SZ');
      expect(szJob.postalCode).toBe('8808');
      expect(szJob.addressLocality).toBe('Pfäffikon');
      expect(szJob.addressRegion).toBe('SZ');

      const zgJob = jobs.find((j: { title: string }) => j.title.startsWith('Sozialarbeiter'));
      expect(zgJob.location).toBe('Baar');
      expect(zgJob.canton).toBe('ZG');
      expect(zgJob.postalCode).toBe('6340');

      // The regression this test guards: both jobs must NOT collapse onto
      // the same hardcoded city.
      expect(szJob.location).not.toBe(zgJob.location);
      expect(szJob.canton).not.toBe(zgJob.canton);

      expect(szJob.description).toMatch(/Pfäffikon \(SZ\)/);
      expect(zgJob.description).toMatch(/Baar \(ZG\)/);
      expect(szJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
      expect(szJob.id).toMatch(/^triaplus-/);
    });

    it('falls back to DEFAULT_CITY/DEFAULT_CANTON only when a job genuinely has no parsable ort span', async () => {
      mockFetch({
        [LISTING_URL]: LISTING_HTML,
        [urlFor('assistenzaerztin-oder-fachaerztin-w-m-d-ambulant')]: '<!doctype html><html><body><h1>Assistenzärztin</h1><h3>Ihre Aufgaben beinhalten</h3><ul><li>Betreuung von Patientinnen</li></ul></body></html>',
        [urlFor('sozialarbeiter-in-w-m-d')]: detailHtml({
          title: 'Sozialarbeiter/in (w/m/d)',
          ortSpan: '<span class="ort">in  Baar</span>',
        }),
      });

      const jobs = await fetchAllTriaplusJobs();
      const fallbackJob = jobs.find((j: { title: string }) => j.title.startsWith('Assistenzärztin'));
      expect(fallbackJob.location).toBe('Oberwil');
      expect(fallbackJob.canton).toBe('ZG');
      expect(fallbackJob.postalCode).toBe('6317');

      const realJob = jobs.find((j: { title: string }) => j.title.startsWith('Sozialarbeiter'));
      expect(realJob.location).toBe('Baar');
    });

    it('returns [] (no throw) when the listing page has no job hrefs', async () => {
      mockFetch({ [LISTING_URL]: '<html><body>no jobs</body></html>' });
      const jobs = await fetchAllTriaplusJobs();
      expect(jobs).toEqual([]);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      expect(slugify('Assistenzärztin oder Fachärztin (w/m/d)')).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
