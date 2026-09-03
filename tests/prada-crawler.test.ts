/**
 * Tests for the Prada Group crawler parser.
 *
 * Tests parsePradaListingHtml(), parsePradaDetailHtml(),
 * slugify(), stripHtml(), inferEmploymentType()
 * using HTML fixtures matching the real SAP SuccessFactors portal.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  fetchPradaDetailPage,
  fetchPradaJobUrls,
  normalizePradaJobUrl,
  resolvePradaTicinoLocation,
  parsePradaListingHtml,
  parsePradaDetailHtml,
  slugify,
  stripHtml,
  inferEmploymentType,
} from '@/scripts/lib/prada-job-parser.mjs';
import { archiveRemovedJobsToSlice } from '@/scripts/lib/expired-jobs-archive.mjs';
import { sanitizeLocalityForRegion } from '@/build-plugins/shared/jobPostingSchema';

// ── Fixtures matching real SuccessFactors search results ────────────────────

const LISTING_HTML_FIXTURE = `
<html>
<body>
<div id="content">
  <table class="searchResults" role="presentation">
    <tr class="data-row clickable-row" data-href="/job/Mendrisio-Mendrisio-Outlet-Client-Advisor-part-time-domenicale-%28limited-contract%29/1377980233/">
      <td class="jobTitle hidden-phone">
        <a class="jobTitle-link" href="/job/Mendrisio-Mendrisio-Outlet-Client-Advisor-part-time-domenicale-%28limited-contract%29/1377980233/">Mendrisio Outlet Client Advisor part-time domenicale (limited contract)</a>
      </td>
      <td class="colLocation hidden-phone">Mendrisio</td>
    </tr>
    <tr class="data-row clickable-row" data-href="/job/St-Moritz-St-Moritz-Client-Advisor/1379515033/">
      <td class="jobTitle hidden-phone">
        <a class="jobTitle-link" href="/job/St-Moritz-St-Moritz-Client-Advisor/1379515033/">St. Moritz Client Advisor</a>
      </td>
      <td class="colLocation hidden-phone">St. Moritz</td>
    </tr>
    <!-- Mobile duplicate rows (SuccessFactors renders both) -->
    <tr class="data-row visible-phone clickable-row" data-href="/job/Mendrisio-Mendrisio-Outlet-Client-Advisor-part-time-domenicale-%28limited-contract%29/1377980233/">
      <td class="jobTitle">
        <a class="jobTitle-link" href="/job/Mendrisio-Mendrisio-Outlet-Client-Advisor-part-time-domenicale-%28limited-contract%29/1377980233/">Mendrisio Outlet Client Advisor part-time domenicale (limited contract)</a>
      </td>
      <td class="colLocation">Mendrisio</td>
    </tr>
    <tr class="data-row visible-phone clickable-row" data-href="/job/St-Moritz-St-Moritz-Client-Advisor/1379515033/">
      <td class="jobTitle">
        <a class="jobTitle-link" href="/job/St-Moritz-St-Moritz-Client-Advisor/1379515033/">St. Moritz Client Advisor</a>
      </td>
      <td class="colLocation">St. Moritz</td>
    </tr>
  </table>
</div>
</body>
</html>
`;

const DETAIL_HTML_FIXTURE = `
<html>
<body>
<div class="jobdetail-container">
  <h1 class="jobTitle">Mendrisio Outlet Client Advisor part-time domenicale (limited contract)</h1>
  <span class="jobdetail-location">Mendrisio</span>
  <span class="jobdetail-department">Retail</span>
  <div class="jobdetail-externalDescription">
    <p>Il Gruppo Prada cerca un Client Advisor per il nostro outlet di Mendrisio.
       Il candidato ideale ha esperienza nel retail di lusso e passione per la moda.</p>
    <h3>Responsabilità</h3>
    <ul>
      <li>Accoglienza e assistenza clienti</li>
      <li>Vendita dei prodotti Prada e Miu Miu</li>
      <li>Mantenimento degli standard del brand</li>
    </ul>
    <h3>Requisiti</h3>
    <ul>
      <li>Esperienza nel retail di lusso</li>
      <li>Conoscenza fluente di italiano e inglese</li>
      <li>Disponibilità lavoro domenicale</li>
    </ul>
  </div>
</div>
</body>
</html>
`;

const EMPTY_SEARCH_HTML = `
<html>
<body>
<div id="content">
  <table class="searchResults" role="presentation">
    <tr class="no-results">
      <td>No jobs found matching your criteria.</td>
    </tr>
  </table>
</div>
</body>
</html>
`;

// ── Tests ────────────────────────────────────────────────────────

describe('Prada Group crawler — URL boundary', () => {
  it('allows only relative or same-origin HTTPS Prada job routes', () => {
    const path = '/job/Mendrisio-Client-Advisor/1377980233/';
    expect(normalizePradaJobUrl(path)).toBe(`https://jobs.pradagroup.com${path}`);
    expect(normalizePradaJobUrl(`https://jobs.pradagroup.com${path}`))
      .toBe(`https://jobs.pradagroup.com${path}`);
    expect(normalizePradaJobUrl(`https://attacker.example${path}`)).toBeNull();
    expect(normalizePradaJobUrl(`http://jobs.pradagroup.com${path}`)).toBeNull();
    expect(normalizePradaJobUrl('https://jobs.pradagroup.com/search/1377980233/')).toBeNull();
  });

  it('fails closed before fetch for an unsafe detail URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(fetchPradaDetailPage('https://attacker.example/job/Mendrisio-Client-Advisor/1377980233/'))
        .resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('retries a transient partial-snapshot failure and publishes only after both queries recover', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: 'https://jobs.pradagroup.com/search/?q=&locationsearch=switzerland&searchby=location',
        text: async () => LISTING_HTML_FIXTURE,
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        url: 'https://jobs.pradagroup.com/search/?q=&locationsearch=ticino&searchby=location',
        text: async () => '',
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: 'https://jobs.pradagroup.com/search/?q=&locationsearch=ticino&searchby=location',
        text: async () => LISTING_HTML_FIXTURE,
      } as Response);
    try {
      await expect(fetchPradaJobUrls()).resolves.toHaveLength(2);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally {
      fetchSpy.mockRestore();
      warnSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('bounds persistent transient retries and still discards the partial snapshot', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: 'https://jobs.pradagroup.com/search/?q=&locationsearch=switzerland&searchby=location',
        text: async () => LISTING_HTML_FIXTURE,
      } as Response)
      .mockResolvedValue({
        ok: false,
        status: 503,
        url: 'https://jobs.pradagroup.com/search/?q=&locationsearch=ticino&searchby=location',
        text: async () => '',
      } as Response);
    try {
      await expect(fetchPradaJobUrls()).resolves.toEqual([]);
      expect(fetchSpy).toHaveBeenCalledTimes(4); // first query + 3 bounded attempts
    } finally {
      fetchSpy.mockRestore();
      warnSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('retries a proven network error without treating it as an authoritative empty snapshot', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue({
        ok: true,
        status: 200,
        url: 'https://jobs.pradagroup.com/search/?q=&locationsearch=switzerland&searchby=location',
        text: async () => LISTING_HTML_FIXTURE,
      } as Response);
    try {
      await expect(fetchPradaJobUrls()).resolves.toHaveLength(2);
      expect(fetchSpy).toHaveBeenCalledTimes(3); // retry + second authoritative query
    } finally {
      fetchSpy.mockRestore();
      warnSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('fails closed without retrying a structural redirect', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 302,
      url: 'https://jobs.pradagroup.com/search/?q=&locationsearch=switzerland&searchby=location',
      text: async () => '',
    } as Response);
    try {
      await expect(fetchPradaJobUrls()).resolves.toEqual([]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    } finally {
      fetchSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it.each([
    'https://attacker.example/search/?q=',
    'https://jobs.pradagroup.com/job/Mendrisio-Client-Advisor/1377980233/',
  ])('fails closed without retrying an untrusted effective search URL: %s', async (effectiveUrl) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      url: effectiveUrl,
      text: async () => LISTING_HTML_FIXTURE,
    } as Response);
    try {
      await expect(fetchPradaJobUrls()).resolves.toEqual([]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('fails closed on a 200 response without the authoritative listing table', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://jobs.pradagroup.com/search/',
      text: async () => '<html><body>Access denied</body></html>',
    } as Response);
    try {
      await expect(fetchPradaJobUrls()).resolves.toEqual([]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('rejects off-domain listing links without reserving their job ID', () => {
    const html = `
      <a class="jobTitle-link" href="https://attacker.example/job/Fake/1377980233/">Fake job</a>
      <a class="jobTitle-link" href="/job/Mendrisio-Client-Advisor/1377980233/">Client Advisor</a>`;
    expect(parsePradaListingHtml(html).map((job) => job.url))
      .toEqual(['https://jobs.pradagroup.com/job/Mendrisio-Client-Advisor/1377980233/']);
  });
});

describe('Prada Group crawler — Ticino ownership', () => {
  it('accepts source-backed Mendrisio locations and canonical route fallback', () => {
    const url = 'https://jobs.pradagroup.com/job/Mendrisio-Client-Advisor/1377980233/';
    expect(resolvePradaTicinoLocation({ location: 'Mendrisio', url })).toBe('Mendrisio');
    expect(resolvePradaTicinoLocation({ location: 'Mendrisio, TI, Switzerland', url }))
      .toBe('Mendrisio');
    expect(resolvePradaTicinoLocation({
      location: '',
      url,
    })).toBe('Mendrisio');
  });

  it.each([
    ['Arezzo Purchasing intern', 'https://jobs.pradagroup.com/job/Arezzo-Purchasing-intern/1387030233/'],
    ['Nearest Major Market: Las Vegas', 'https://jobs.pradagroup.com/job/Las-Vegas-Client-Advisor/1387030234/'],
    ['St. Moritz', 'https://jobs.pradagroup.com/job/St-Moritz-Client-Advisor/1387030235/'],
    ['', 'https://jobs.pradagroup.com/job/Milano-Digital-Content-Intern/1387030236/'],
  ])('rejects non-Ticino source evidence: %s', (location, url) => {
    expect(resolvePradaTicinoLocation({ location, url })).toBeNull();
  });

  it('tolerates real SuccessFactors detail-page location formatting without dropping a valid Mendrisio job', () => {
    const url = 'https://jobs.pradagroup.com/job/Mendrisio-Client-Advisor/1377980233/';
    // Postal-code-prefixed variants seen on detail pages (same convention
    // already handled for other crawlers, e.g. agroscope-job-parser.mjs).
    expect(resolvePradaTicinoLocation({ location: '6850 Mendrisio', url })).toBe('Mendrisio');
    expect(resolvePradaTicinoLocation({ location: 'CH-6850 Mendrisio, Ticino', url }))
      .toBe('Mendrisio');
    // Hyphen-joined variant (same bug class: a space-only strip left this
    // unstripped and still fail-closed).
    expect(resolvePradaTicinoLocation({ location: '6850-Mendrisio', url })).toBe('Mendrisio');
    // Case and stray whitespace already tolerated — kept here as regression guards.
    expect(resolvePradaTicinoLocation({ location: '  MENDRISIO  ', url })).toBe('Mendrisio');
  });

  it('canonicalizes every accepted variant before slug and JobPosting locality consumers', () => {
    const url = 'https://jobs.pradagroup.com/job/Mendrisio-Client-Advisor/1377980233/';
    const resolved = ['Mendrisio', '6850 Mendrisio', '6850-Mendrisio']
      .map((location) => resolvePradaTicinoLocation({ location, url }));

    expect(resolved).toEqual(['Mendrisio', 'Mendrisio', 'Mendrisio']);
    expect(new Set(resolved.map((location) => slugify(`Client Advisor-prada-group-${location}`))))
      .toEqual(new Set(['client-advisor-prada-group-mendrisio']));
    for (const location of resolved) {
      expect(sanitizeLocalityForRegion(String(location), 'TI')).toBe('Mendrisio');
    }
  });

  it('still rejects a bare postal code or a foreign city sharing no Mendrisio prefix', () => {
    const url = 'https://jobs.pradagroup.com/job/Mendrisio-Client-Advisor/1377980233/';
    expect(resolvePradaTicinoLocation({ location: '6850', url })).toBeNull();
    expect(resolvePradaTicinoLocation({ location: '6850--', url })).toBeNull();
    expect(resolvePradaTicinoLocation({ location: '6850--Mendrisio', url })).toBeNull();
    expect(resolvePradaTicinoLocation({ location: '6900 Lugano', url })).toBeNull();
    expect(resolvePradaTicinoLocation({ location: '6900-Lugano', url })).toBeNull();
  });

  it('does not let a Mendrisio title override an authoritative foreign location', () => {
    expect(resolvePradaTicinoLocation({
      location: 'Arezzo',
      url: 'https://jobs.pradagroup.com/job/Arezzo-Mendrisio-Manager/1387030237/',
    })).toBeNull();
  });

  it('rejects a historical foreign route even when its stale location was defaulted to Mendrisio', () => {
    expect(resolvePradaTicinoLocation({
      location: 'Mendrisio',
      url: 'https://jobs.pradagroup.com/job/Paris-Client-Advisor/1387030238/',
    })).toBeNull();
  });

  it('archives a retired foreign route with its slug history intact', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'prada-expired-'));
    const prior = {
      slug: 'purchasing-intern-prada-group-arezzo',
      title: 'Purchasing intern',
      company: 'Prada Group',
      companyKey: 'prada',
      location: 'Arezzo',
      url: 'https://jobs.pradagroup.com/job/Arezzo-Purchasing-intern/1387030233/',
      slugByLocale: { it: 'stage-acquisti-prada-arezzo' },
      previousSlugs: ['purchasing-intern-prada-arezzo'],
      previousSlugsByLocale: { it: ['vecchio-stage-acquisti-prada-arezzo'] },
    };
    try {
      const retired = [prior].filter((job) => !resolvePradaTicinoLocation(job));
      expect(archiveRemovedJobsToSlice(retired, 'prada', { dir })).toBe(1);
      const archived = JSON.parse(readFileSync(path.join(dir, 'prada.json'), 'utf8'));
      expect(archived[0]).toMatchObject({
        slug: prior.slug,
        slugByLocale: prior.slugByLocale,
        previousSlugs: prior.previousSlugs,
        previousSlugsByLocale: prior.previousSlugsByLocale,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Prada Group crawler — SuccessFactors listing parsing', () => {
  it('extracts jobs from SuccessFactors search results', () => {
    const jobs = parsePradaListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs.length).toBe(2); // 2 unique jobs, duplicates removed
  });

  it('extracts correct job titles', () => {
    const jobs = parsePradaListingHtml(LISTING_HTML_FIXTURE);
    const titles = jobs.map((j) => j.title);
    expect(titles).toContain('Mendrisio Outlet Client Advisor part-time domenicale (limited contract)');
    expect(titles).toContain('St. Moritz Client Advisor');
  });

  it('builds correct URLs from SuccessFactors hrefs', () => {
    const jobs = parsePradaListingHtml(LISTING_HTML_FIXTURE);
    const mendrisioJob = jobs.find((j) => j.title.includes('Mendrisio'));
    expect(mendrisioJob!.url).toBe('https://jobs.pradagroup.com/job/Mendrisio-Mendrisio-Outlet-Client-Advisor-part-time-domenicale-%28limited-contract%29/1377980233/');
  });

  it('extracts job IDs from URL path', () => {
    const jobs = parsePradaListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs[0].jobId).toBe('1377980233');
    expect(jobs[1].jobId).toBe('1379515033');
  });

  it('extracts location from colLocation cells', () => {
    const jobs = parsePradaListingHtml(LISTING_HTML_FIXTURE);
    const mendrisioJob = jobs.find((j) => j.title.includes('Mendrisio'));
    const stMoritzJob = jobs.find((j) => j.title.includes('St. Moritz'));
    expect(mendrisioJob!.location).toBe('Mendrisio');
    expect(stMoritzJob!.location).toBe('St. Moritz');
  });

  it('keeps the visible office of a multi-location row (nested "+N more" marker)', () => {
    const multiLocation = LISTING_HTML_FIXTURE.replace(
      '<td class="colLocation hidden-phone">Mendrisio</td>',
      '<td class="colLocation hidden-phone">Mendrisio <small class="nobr">+3 more&hellip;</small></td>',
    );
    const jobs = parsePradaListingHtml(multiLocation);
    const mendrisioJob = jobs.find((j) => j.title.includes('Mendrisio'));
    expect(mendrisioJob!.location).toBe('Mendrisio');
  });

  it('deduplicates desktop and mobile rows by jobId', () => {
    // The fixture has 4 rows (2 desktop + 2 mobile) but only 2 unique jobs
    const jobs = parsePradaListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs.length).toBe(2);
  });

  it('returns empty array for empty input', () => {
    expect(parsePradaListingHtml('')).toHaveLength(0);
    expect(parsePradaListingHtml(null as any)).toHaveLength(0);
  });

  it('returns empty array for no-results page', () => {
    expect(parsePradaListingHtml(EMPTY_SEARCH_HTML)).toHaveLength(0);
  });

  it('sets canton to TI', () => {
    const jobs = parsePradaListingHtml(LISTING_HTML_FIXTURE);
    jobs.forEach((j) => expect(j.canton).toBe('TI'));
  });

  it('sets id with prada- prefix', () => {
    const jobs = parsePradaListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs[0].id).toBe('prada-1377980233');
  });
});

describe('Prada Group crawler — SuccessFactors detail page parsing', () => {
  it('extracts description from jobdetail-externalDescription', () => {
    const result = parsePradaDetailHtml(DETAIL_HTML_FIXTURE);
    expect(result).not.toBeNull();
    expect(result!.description).toContain('Client Advisor');
    expect(result!.description).toContain('Mendrisio');
    expect(result!.description).toContain('retail di lusso');
  });

  it('strips HTML from description', () => {
    const result = parsePradaDetailHtml(DETAIL_HTML_FIXTURE);
    expect(result!.description).not.toMatch(/<[a-z]/i);
  });

  it('extracts title from h1', () => {
    const result = parsePradaDetailHtml(DETAIL_HTML_FIXTURE);
    expect(result!.title).toContain('Mendrisio Outlet Client Advisor');
  });

  it('extracts location from jobdetail-location', () => {
    const result = parsePradaDetailHtml(DETAIL_HTML_FIXTURE);
    expect(result!.location).toBe('Mendrisio');
  });

  it('extracts department from jobdetail-department', () => {
    const result = parsePradaDetailHtml(DETAIL_HTML_FIXTURE);
    expect(result!.department).toBe('Retail');
  });

  it('returns null for empty input', () => {
    expect(parsePradaDetailHtml('')).toBeNull();
    expect(parsePradaDetailHtml(null as any)).toBeNull();
  });
});

describe('Prada Group crawler — slugify', () => {
  it('generates correct slug', () => {
    expect(slugify('Mendrisio Outlet Client Advisor')).toBe('mendrisio-outlet-client-advisor');
  });

  it('handles accented characters', () => {
    expect(slugify('Coordinatore Logística à Mendrisio')).toBe('coordinatore-logistica-a-mendrisio');
  });

  it('truncates long slugs to 180 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(180);
  });
});

describe('Prada Group crawler — stripHtml', () => {
  it('removes HTML tags', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).not.toMatch(/<[a-z]/i);
  });

  it('decodes HTML entities', () => {
    expect(stripHtml('AT&amp;T')).toContain('AT&T');
  });

  it('returns empty string for empty input', () => {
    expect(stripHtml('')).toBe('');
  });
});

describe('Prada Group crawler — inferEmploymentType', () => {
  it('returns FULL_TIME for 100%', () => {
    expect(inferEmploymentType('Store Manager 100%')).toBe('FULL_TIME');
  });

  it('returns PART_TIME for 50%', () => {
    expect(inferEmploymentType('Sales Associate 50%')).toBe('PART_TIME');
  });

  it('returns PART_TIME for part-time in title', () => {
    expect(inferEmploymentType('Client Advisor part-time domenicale')).toBe('PART_TIME');
  });

  it('returns PART_TIME for tempo parziale', () => {
    expect(inferEmploymentType('Addetto vendite tempo parziale')).toBe('PART_TIME');
  });

  it('defaults to FULL_TIME', () => {
    expect(inferEmploymentType('Visual Merchandiser')).toBe('FULL_TIME');
  });
});
