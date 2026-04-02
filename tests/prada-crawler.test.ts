/**
 * Tests for the Prada Group crawler parser.
 *
 * Tests parsePradaListingHtml(), parsePradaDetailHtml(),
 * slugify(), stripHtml(), inferEmploymentType()
 * using HTML fixtures matching the real SAP SuccessFactors portal.
 */
import { describe, it, expect } from 'vitest';
import {
  parsePradaListingHtml,
  parsePradaDetailHtml,
  slugify,
  stripHtml,
  inferEmploymentType,
} from '@/scripts/lib/prada-job-parser.mjs';

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
