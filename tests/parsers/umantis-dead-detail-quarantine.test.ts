/**
 * Tests for the Umantis "dead detail URL" quarantine (issue #1245).
 *
 * Several Umantis tenants deprecated `/Vacancies/{id}/Description/1` — it now
 * 3xx-redirects AWAY from the umantis host (→ public career site / migrated
 * ATS). Following that redirect lands on careers chrome that the extractor
 * cannot parse, so the crawler used to synthesise generic German boilerplate
 * which the dataset boilerplate-guard then HARD-FAILED on, filing an issue
 * every run.
 *
 * The structural fix:
 *   1. `isCrossHostRedirect` — detect the deprecation (Location leaves host).
 *   2. `fetchUmantisDetailResult` — report `deadDetail: true` instead of
 *      following the cross-host redirect.
 *   3. `createUmantisListingParser` — QUARANTINE dead-detail jobs (skip emit)
 *      so the crawler succeeds with the remaining good jobs and never feeds the
 *      guard boilerplate; a still-200 tenant is unaffected.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isCrossHostRedirect,
  fetchUmantisDetailResult,
  fetchUmantisDetailContentResult,
} from '../../scripts/lib/umantis-detail-helpers.mjs';
import { createUmantisListingParser } from '../../scripts/lib/umantis-listing-common.mjs';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A minimal fetch Response stand-in. */
function res({ status = 200, body = '', location = '' }: { status?: number; body?: string; location?: string }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'location' ? location : null) },
    text: async () => body,
  };
}

describe('isCrossHostRedirect', () => {
  const detailUrl = 'https://recruitingapp-2782.umantis.com/Vacancies/123/Description/1?lang=ger';

  it('flags an absolute cross-host redirect (migrated to public site)', () => {
    expect(isCrossHostRedirect(detailUrl, 'https://www.paraplegie.ch/de/jobs')).toBe(true);
  });

  it('flags a redirect to a different ATS (Prospective)', () => {
    expect(isCrossHostRedirect(detailUrl, 'https://jobs.prospective.ch/some-job')).toBe(true);
  });

  it('does NOT flag a same-host canonicalisation redirect', () => {
    expect(isCrossHostRedirect(detailUrl, 'https://recruitingapp-2782.umantis.com/Vacancies/123/Description/1?lang=fre')).toBe(false);
  });

  it('does NOT flag a relative (same-host) Location', () => {
    expect(isCrossHostRedirect(detailUrl, '/Vacancies/123/Description/1')).toBe(false);
  });

  it('returns false for an empty Location', () => {
    expect(isCrossHostRedirect(detailUrl, '')).toBe(false);
  });
});

describe('fetchUmantisDetailResult — dead-detail detection', () => {
  const BASE = 'https://recruitingapp-2782.umantis.com';

  it('reports deadDetail on a cross-host 302 and does NOT follow it', async () => {
    const fetchMock = vi.fn(async () =>
      res({ status: 302, location: 'https://www.paraplegie.ch/de/offene-stellen' }),
    );
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const out = await fetchUmantisDetailResult(BASE, 123, { lang: 'ger', delayMs: 0 });
    expect(out.deadDetail).toBe(true);
    expect(out.html).toBe('');
    // Only the initial probe — the cross-host redirect is never followed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns html and deadDetail=false on a plain 200', async () => {
    const html = '<html><body><h2 id="expander-1">Aufgaben</h2><div id="expandable-1">real body content here</div></body></html>';
    const fetchMock = vi.fn(async () => res({ status: 200, body: html }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const out = await fetchUmantisDetailResult(BASE, 123, { lang: 'ger', delayMs: 0 });
    expect(out.deadDetail).toBe(false);
    expect(out.html).toContain('Aufgaben');
  });

  it('follows a SAME-host redirect once (lang canon) without flagging dead', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (calls.length === 1) {
        return res({ status: 302, location: `${BASE}/Vacancies/123/Description/1?lang=ger&canon=1` });
      }
      return res({ status: 200, body: '<html>followed body</html>' });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const out = await fetchUmantisDetailResult(BASE, 123, { lang: 'ger', delayMs: 0 });
    expect(out.deadDetail).toBe(false);
    expect(out.html).toContain('followed body');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fetchUmantisDetailContentResult propagates deadDetail and yields empty content', async () => {
    const fetchMock = vi.fn(async () =>
      res({ status: 301, location: 'https://example.com/careers' }),
    );
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const out = await fetchUmantisDetailContentResult(BASE, 123, { lang: 'ger', delayMs: 0 });
    expect(out.deadDetail).toBe(true);
    expect(out.content).toBe('');
  });
});

describe('createUmantisListingParser — quarantine vs hard-fail', () => {
  const LISTING_HTML = `
    <table>
      <tr class="table-as-list__contentrow1">
        <h3 class="table-as-list__subtitle tableaslist_element_1152488">
          <a href="/Vacancies/111/Description/1">Pflegefachperson HF 80%</a>
        </h3>
      </tr>
      <tr class="table-as-list__contentrow2">
        <h3 class="table-as-list__subtitle tableaslist_element_1152488">
          <a href="/Vacancies/222/Description/1">Fachperson Gesundheit EFZ</a>
        </h3>
      </tr>
    </table>`;

  const REAL_DETAIL = (title: string) =>
    `<html><body><li class="customdatablock" id="customdatablock_1"><ul><li>Aufgaben: ${title} mit vielen Verantwortlichkeiten im Pflegebereich des Spitals</li></ul></li></body></html>`;

  function makeFactory() {
    return createUmantisListingParser({
      companyKey: 'test-tenant',
      companyName: 'Test Spital',
      companyDomain: 'test-spital.ch',
      tenantId: 2782,
      defaultCanton: 'TI',
      defaultCity: 'Lugano',
      defaultPostalCode: '6900',
    });
  }

  it('quarantines a dead-detail job (no boilerplate) and emits the good one', async () => {
    const fetchMock = vi.fn(async (url: string, init?: { redirect?: string }) => {
      if (url.includes('/Jobs/All')) return res({ status: 200, body: LISTING_HTML });
      // Job 111 → dead detail (cross-host 302). Job 222 → real 200 body.
      if (url.includes('/Vacancies/111/')) {
        return res({ status: 302, location: 'https://www.test-spital.ch/karriere' });
      }
      if (url.includes('/Vacancies/222/')) {
        return res({ status: 200, body: REAL_DETAIL('Fachperson Gesundheit') });
      }
      return res({ status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { fetchAllJobs } = makeFactory();
    const jobs = await fetchAllJobs();

    // Dead-detail job 111 is quarantined; good job 222 survives.
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toMatch(/Fachperson Gesundheit/);
    // The emitted job is NOT synthetic boilerplate — it carries the real body.
    expect(jobs[0].description).toMatch(/Aufgaben/);
    // No emitted job carries the Umantis-Karriereportal boilerplate sentinel.
    for (const j of jobs) {
      expect(j.description).not.toMatch(/Bewerbung über das Umantis-Karriereportal/);
    }
  });

  it('exits cleanly with 0 jobs when EVERY job is dead-detail (no throw, no boilerplate)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/Jobs/All')) return res({ status: 200, body: LISTING_HTML });
      // Both detail URLs are dead → migrated away entirely.
      return res({ status: 302, location: 'https://www.test-spital.ch/karriere' });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { fetchAllJobs } = makeFactory();
    // Must NOT throw — degraded/migrated source must not brick the crawler.
    const jobs = await fetchAllJobs();
    expect(jobs).toEqual([]);
  });

  it('allowBoilerplateOnDeadDetail=true emits jobs with structured boilerplate on dead-detail (kispi-sg / paraplegie mode)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/Jobs/All')) return res({ status: 200, body: LISTING_HTML });
      // Both detail URLs are dead (cross-host 302).
      return res({ status: 302, location: 'https://www.test-spital.ch/karriere' });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { fetchAllJobs } = createUmantisListingParser({
      companyKey: 'test-tenant',
      companyName: 'Test Spital',
      companyDomain: 'test-spital.ch',
      tenantId: 2782,
      defaultCanton: 'TI',
      defaultCity: 'Lugano',
      defaultPostalCode: '6900',
      allowBoilerplateOnDeadDetail: true,
    });
    const jobs = await fetchAllJobs();

    // Both jobs emitted despite dead detail URLs.
    expect(jobs).toHaveLength(2);
    // Each job must have a non-empty structured description (not just a title).
    for (const j of jobs) {
      expect(j.description.length).toBeGreaterThan(40);
      expect(j.title.length).toBeGreaterThan(3);
    }
  });

  it('a still-200 tenant is unaffected (both jobs emitted with real content)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/Jobs/All')) return res({ status: 200, body: LISTING_HTML });
      if (url.includes('/Vacancies/111/')) return res({ status: 200, body: REAL_DETAIL('Pflegefachperson') });
      if (url.includes('/Vacancies/222/')) return res({ status: 200, body: REAL_DETAIL('Fachperson Gesundheit') });
      return res({ status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { fetchAllJobs } = makeFactory();
    const jobs = await fetchAllJobs();
    expect(jobs).toHaveLength(2);
    for (const j of jobs) {
      expect(j.description).toMatch(/Aufgaben/);
    }
  });
});
