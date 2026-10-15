import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  INTEGRA_BIOSCIENCES_KEY,
  INTEGRA_BIOSCIENCES_COMPANY_NAME,
  isIntegraBiosciencesJob,
  isTrustedDomain,
  parseListingTable,
  parseJobsAllData,
  parseDetailPage,
  parseDetailLocation,
  detectCategory,
  detectExperienceLevel,
  inferEmploymentType,
  fetchAllIntegraBiosciencesJobs,
} from '../scripts/lib/integra-biosciences-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import {
  authoritativeEmptySnapshotValidator,
  isAuthoritativeEmptySnapshot,
} from '../scripts/lib/authoritative-empty-snapshot.mjs';
import { EMPTY_OK_CRAWLERS } from '../scripts/lib/crawler-empty-ok-registry.mjs';

describe('INTEGRA Biosciences crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(INTEGRA_BIOSCIENCES_KEY).toBe('integra-biosciences');
    expect(INTEGRA_BIOSCIENCES_COMPANY_NAME).toBe('INTEGRA Biosciences');
  });

  // ── isCompanyJob ──
  describe('isIntegraBiosciencesJob', () => {
    it('matches by companyKey', () => {
      expect(isIntegraBiosciencesJob({ companyKey: 'integra-biosciences' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isIntegraBiosciencesJob({ company: 'INTEGRA Biosciences' })).toBe(true);
    });

    it('matches by company name case-insensitive', () => {
      expect(isIntegraBiosciencesJob({ company: 'integra biosciences AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isIntegraBiosciencesJob({ url: 'https://www.integra-biosciences.com/global/en/careers/senior-engineer' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isIntegraBiosciencesJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isIntegraBiosciencesJob(null)).toBe(false);
      expect(isIntegraBiosciencesJob(undefined)).toBe(false);
      expect(isIntegraBiosciencesJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://integra-biosciences.com/careers/job-123')).toBe(true);
    });

    it('trusts www subdomain', () => {
      expect(isTrustedDomain('https://www.integra-biosciences.com/global/en/careers/senior-engineer')).toBe(true);
    });

    it('trusts other subdomains', () => {
      expect(isTrustedDomain('https://careers.integra-biosciences.com/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('rejects similar but different domains', () => {
      expect(isTrustedDomain('https://fake-integra-biosciences.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── parseListingTable ──
  describe('parseListingTable', () => {
    const sampleHtml = `
      <table class="cols-3">
        <thead><tr>
          <th id="view-title-table-column" class="views-field views-field-title" scope="col">Title</th>
          <th id="view-field-business-area-table-column" class="views-field views-field-field-business-area" scope="col">Business Area</th>
          <th id="view-field-job-country-table-column" class="views-field views-field-field-job-country" scope="col">Country</th>
        </tr></thead>
        <tbody>
          <tr>
            <td headers="view-title-table-column" class="views-field views-field-title"><a href="/global/en/careers/senior-projektleiter-gerateentwicklung-mw-i-100" hreflang="en">Senior Projektleiter Geräteentwicklung (m/w I 100%)</a> </td>
            <td headers="view-field-business-area-table-column" class="views-field views-field-field-business-area">Engineering </td>
            <td headers="view-field-job-country-table-column" class="views-field views-field-field-job-country">Switzerland </td>
          </tr>
          <tr>
            <td headers="view-title-table-column" class="views-field views-field-title"><a href="/global/en/careers/elektronikentwickler-mw-100" hreflang="en">Elektronikentwickler (m/w | 100%)</a> </td>
            <td headers="view-field-business-area-table-column" class="views-field views-field-field-business-area">Engineering </td>
            <td headers="view-field-job-country-table-column" class="views-field views-field-field-job-country">Switzerland </td>
          </tr>
          <tr>
            <td headers="view-title-table-column" class="views-field views-field-title"><a href="/global/en/careers/junior-controller-mw-80-100" hreflang="en">Junior Controller (m/w | 80-100%)</a> </td>
            <td headers="view-field-business-area-table-column" class="views-field views-field-field-business-area">Finance &amp; Administration </td>
            <td headers="view-field-job-country-table-column" class="views-field views-field-field-job-country">Switzerland </td>
          </tr>
          <tr>
            <td headers="view-title-table-column" class="views-field views-field-title"><a href="/global/en/careers/content-marketing-manager-mf-80-100" hreflang="en">Content Marketing Manager (m/f | 80-100%)</a> </td>
            <td headers="view-field-business-area-table-column" class="views-field views-field-field-business-area">Innovation </td>
            <td headers="view-field-job-country-table-column" class="views-field views-field-field-job-country">Switzerland </td>
          </tr>
        </tbody>
      </table>
    `;

    it('parses correct number of jobs from table', () => {
      const jobs = parseListingTable(sampleHtml);
      expect(jobs).toHaveLength(4);
    });

    it('extracts job titles correctly', () => {
      const jobs = parseListingTable(sampleHtml);
      expect(jobs[0].title).toBe('Senior Projektleiter Geräteentwicklung (m/w I 100%)');
      expect(jobs[1].title).toBe('Elektronikentwickler (m/w | 100%)');
      expect(jobs[2].title).toBe('Junior Controller (m/w | 80-100%)');
      expect(jobs[3].title).toBe('Content Marketing Manager (m/f | 80-100%)');
    });

    it('extracts detail URLs correctly', () => {
      const jobs = parseListingTable(sampleHtml);
      expect(jobs[0].detailUrl).toBe('https://www.integra-biosciences.com/global/en/careers/senior-projektleiter-gerateentwicklung-mw-i-100');
      expect(jobs[1].detailUrl).toBe('https://www.integra-biosciences.com/global/en/careers/elektronikentwickler-mw-100');
    });

    it('extracts business area correctly', () => {
      const jobs = parseListingTable(sampleHtml);
      expect(jobs[0].businessArea).toBe('Engineering');
      expect(jobs[2].businessArea).toBe('Finance & Administration');
      expect(jobs[3].businessArea).toBe('Innovation');
    });

    it('extracts country correctly', () => {
      const jobs = parseListingTable(sampleHtml);
      expect(jobs[0].country).toBe('Switzerland');
    });

    it('returns empty array for empty/short HTML', () => {
      expect(parseListingTable('')).toEqual([]);
      expect(parseListingTable('short')).toEqual([]);
    });

    it('skips rows without valid titles', () => {
      const html = `
        <tr>
          <td class="views-field views-field-title"><a href="/careers/x" hreflang="en">AB</a></td>
          <td class="views-field views-field-field-business-area">IT</td>
          <td class="views-field views-field-field-job-country">Switzerland</td>
        </tr>
      `;
      expect(parseListingTable(html)).toEqual([]);
    });

    it('handles absolute URLs in href', () => {
      const html = `
        <tr>
          <td class="views-field views-field-title"><a href="https://www.integra-biosciences.com/global/en/careers/test-job" hreflang="en">Test Job Engineer (100%)</a></td>
          <td class="views-field views-field-field-business-area">Engineering</td>
          <td class="views-field views-field-field-job-country">Switzerland</td>
        </tr>
      `;
      const jobs = parseListingTable(html);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].detailUrl).toBe('https://www.integra-biosciences.com/global/en/careers/test-job');
    });

    // Live markup (Jul 2026) served by the global open-positions table: rows
    // carry the FULL country name in the Country column ("United States",
    // "Canada", "Switzerland"). The crawler fetches the unfiltered global list
    // and selects Swiss rows client-side — proven here on the real structure.
    const MIXED_COUNTRY_HTML = `
      <table class="cols-3">
        <thead><tr>
          <th class="views-field views-field-title" scope="col">Title</th>
          <th class="views-field views-field-field-business-area" scope="col">Business Area</th>
          <th class="views-field views-field-field-job-country" scope="col">Country</th>
        </tr></thead>
        <tbody>
          <tr>
            <td headers="view-title-table-column" class="views-field views-field-title" data-thead="
            Title
          "><a href="https://www.integra-biosciences.com/global/en/careers/field-calibration-technician" hreflang="en">Field Calibration Technician</a></td>
            <td class="views-field views-field-field-business-area">Sales &amp; Customer Support</td>
            <td class="views-field views-field-field-job-country">United States</td>
          </tr>
          <tr>
            <td headers="view-title-table-column" class="views-field views-field-title" data-thead="
            Title
          "><a href="https://www.integra-biosciences.com/global/en/careers/mitarbeiter-qualitatssicherung-spritzguss-wmd-100" hreflang="en">Mitarbeiter Qualitätssicherung Spritzguss (m/w/d) 100%</a></td>
            <td class="views-field views-field-field-business-area">Quality &amp; Safety Management</td>
            <td class="views-field views-field-field-job-country">Switzerland</td>
          </tr>
          <tr>
            <td headers="view-title-table-column" class="views-field views-field-title" data-thead="
            Title
          "><a href="https://www.integra-biosciences.com/global/en/careers/outside-sales-representative" hreflang="en">Outside Sales Representative</a></td>
            <td class="views-field views-field-field-business-area">Sales &amp; Customer Support</td>
            <td class="views-field views-field-field-job-country">Canada</td>
          </tr>
        </tbody>
      </table>
    `;

    it('parses full country names and lets the client-side filter select Swiss rows', () => {
      const cards = parseListingTable(MIXED_COUNTRY_HTML);
      expect(cards).toHaveLength(3);
      // Mirrors the crawler's client-side filter (country blank/switzerland/ch).
      const swiss = cards.filter((c) => {
        const country = c.country.trim().toLowerCase();
        return !country || country === 'switzerland' || country === 'ch';
      });
      expect(swiss.map((c) => c.title)).toEqual([
        'Mitarbeiter Qualitätssicherung Spritzguss (m/w/d) 100%',
      ]);
      expect(swiss[0].businessArea).toBe('Quality & Safety Management');
    });

    // Real render when INTEGRA has no live positions (its state as of the fix):
    // an empty tbody plus a "no job offers available" panel → 0 jobs, no error.
    it('returns [] for the "no job offers available" empty table', () => {
      const emptyHtml = `
        <table class="cols-3">
          <thead><tr>
            <th class="views-field views-field-title" scope="col">Title</th>
            <th class="views-field views-field-field-business-area" scope="col">Business Area</th>
            <th class="views-field views-field-field-job-country" scope="col">Country</th>
          </tr></thead>
          <tbody>
          </tbody>
        </table>
        <div class="panel no-results">
          <div class="paragraph--text rt-content"><p>There are currently no job offers available.</p></div>
        </div>
      `;
      expect(parseListingTable(emptyHtml)).toEqual([]);
    });
  });

  // ── parseDetailPage ──
  describe('parseDetailPage', () => {
    it('extracts description from JSON-LD', () => {
      const html = `
        <html>
        <script type="application/ld+json">
        {
          "@type": "JobPosting",
          "description": "<p>We are looking for a <strong>Senior Engineer</strong> to join our team.</p>",
          "datePosted": "2026-03-15"
        }
        </script>
        </html>
      `;
      const result = parseDetailPage(html);
      expect(result.description).toContain('Senior Engineer');
      expect(result.datePosted).toBe('2026-03-15');
    });

    it('falls back to field--name-body', () => {
      const html = `
        <div class="field field--name-body field--type-text-with-summary">
          <div class="field__item">
            <p>This is a great opportunity to work at INTEGRA Biosciences in Zizers.</p>
          </div>
        </div>
      `;
      const result = parseDetailPage(html);
      expect(result.description).toContain('great opportunity');
    });

    it('falls back to article content', () => {
      const html = `
        <article class="node node--type-job-offer">
          <div class="content">
            <p>INTEGRA Biosciences is seeking a motivated software developer to join our innovation team in Zizers.</p>
          </div>
        </article>
      `;
      const result = parseDetailPage(html);
      expect(result.description).toContain('software developer');
    });

    it('returns empty for short/empty HTML', () => {
      expect(parseDetailPage('')).toEqual({ description: '', datePosted: '' });
      expect(parseDetailPage('short')).toEqual({ description: '', datePosted: '' });
    });
  });

  // ── detectCategory ──
  describe('detectCategory', () => {
    it('maps business area "Engineering"', () => {
      expect(detectCategory('Some Title', 'Engineering')).toBe('Ingegneria');
    });

    it('maps business area "Finance & Administration"', () => {
      expect(detectCategory('Controller', 'Finance & Administration')).toBe('Amministrazione');
    });

    it('maps business area "IT"', () => {
      expect(detectCategory('System Admin', 'IT')).toBe('IT');
    });

    it('maps business area "Sales"', () => {
      expect(detectCategory('Regional Manager', 'Sales')).toBe('Commerciale');
    });

    it('maps business area "Production"', () => {
      expect(detectCategory('Operator', 'Production')).toBe('Produzione');
    });

    it('maps business area "Quality & Safety Management"', () => {
      expect(detectCategory('Inspector', 'Quality & Safety Management')).toBe('Qualità');
    });

    it('maps business area "Innovation"', () => {
      expect(detectCategory('Scientist', 'Innovation')).toBe('Ricerca e Sviluppo');
    });

    it('falls back to title-based detection for engineering', () => {
      expect(detectCategory('Mechanical Design Engineer (m/w | 100%)', '')).toBe('Ingegneria');
    });

    it('falls back to title-based detection for IT', () => {
      expect(detectCategory('Senior Software-Entwickler C# /.NET', '')).toBe('IT');
    });

    it('falls back to title-based detection for production', () => {
      expect(detectCategory('Fachspezialist Automation', '')).toBe('Produzione');
    });

    it('returns Altro for unknown categories', () => {
      expect(detectCategory('General Position', '')).toBe('Altro');
    });
  });

  // ── detectExperienceLevel ──
  describe('detectExperienceLevel', () => {
    it('detects senior level', () => {
      expect(detectExperienceLevel('Senior Projektleiter Geräteentwicklung')).toBe('senior');
      expect(detectExperienceLevel('Head of Engineering')).toBe('senior');
      expect(detectExperienceLevel('Lead Developer')).toBe('senior');
    });

    it('detects junior level', () => {
      expect(detectExperienceLevel('Junior Controller (m/w | 80-100%)')).toBe('junior');
    });

    it('detects intern level', () => {
      expect(detectExperienceLevel('Praktikant Engineering')).toBe('intern');
      expect(detectExperienceLevel('Lernende/r Informatik')).toBe('intern');
    });

    it('defaults to mid level', () => {
      expect(detectExperienceLevel('Elektronikentwickler (m/w | 100%)')).toBe('mid');
      expect(detectExperienceLevel('Application Scientist (m/f | 100%)')).toBe('mid');
    });
  });

  // ── inferEmploymentType ──
  describe('inferEmploymentType', () => {
    it('detects full-time from 100%', () => {
      expect(inferEmploymentType('Elektronikentwickler (m/w | 100%)')).toBe('FULL_TIME');
    });

    it('detects full-time from 80-100%', () => {
      expect(inferEmploymentType('Junior Controller (m/w | 80-100%)')).toBe('FULL_TIME');
    });

    it('detects part-time from 60-80%', () => {
      expect(inferEmploymentType('Sachbearbeiter (m/w | 60-80%)')).toBe('PART_TIME');
    });

    it('detects part-time from 50%', () => {
      expect(inferEmploymentType('Teilzeitstelle (50%)')).toBe('PART_TIME');
    });

    it('defaults to full-time when no percentage', () => {
      expect(inferEmploymentType('Application Scientist')).toBe('FULL_TIME');
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

    it('handles German umlauts', () => {
      expect(slugify('Geräteentwicklung')).toBe('gerateentwicklung');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer integra-biosciences ch')).toBe('developer-integra-biosciences-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'integra-biosciences-abc123def456',
      slug: 'senior-projektleiter-gerateentwicklung-integra-biosciences-ch',
      slugByLocale: { de: 'senior-projektleiter-gerateentwicklung-integra-biosciences-ch' },
      company: 'INTEGRA Biosciences',
      companyKey: 'integra-biosciences',
      companyDomain: 'integra-biosciences.com',
      title: 'Senior Projektleiter Geräteentwicklung (m/w I 100%)',
      titleByLocale: { de: 'Senior Projektleiter Geräteentwicklung (m/w I 100%)' },
      description: 'Senior Projektleiter Geräteentwicklung — INTEGRA Biosciences. Business Area: Engineering. Location: Zizers (GR), Switzerland.',
      descriptionByLocale: { de: 'Senior Projektleiter Geräteentwicklung — INTEGRA Biosciences. Business Area: Engineering. Location: Zizers (GR), Switzerland.' },
      location: 'Zizers',
      canton: 'GR',
      url: 'https://www.integra-biosciences.com/global/en/careers/senior-projektleiter-gerateentwicklung-mw-i-100',
      source: 'INTEGRA Biosciences Dedicated Parser',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Zizers',
      postalCode: '7205',
      streetAddress: 'Tardisstrasse 201',
      addressCountry: 'CH',
      country: 'CH',
      category: 'Ingegneria',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: 'senior',
      sector: 'Scienze della Vita / Biotecnologia',
      currency: 'CHF',
      featured: false,
      postedDate: '2026-03-15',
      applyUrl: 'https://www.integra-biosciences.com/global/en/careers/senior-projektleiter-gerateentwicklung-mw-i-100',
      requirements: [],
      requirementsByLocale: { de: [] },
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

    it('has all SEO-mandatory fields', () => {
      const seoRequired = [
        'postalCode', 'streetAddress', 'addressLocality',
        'addressCountry', 'employmentType', 'sector',
      ];
      for (const field of seoRequired) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field as keyof typeof validJob]).toBeTruthy();
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^integra-biosciences-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('location is Zizers (INTEGRA HQ)', () => {
      expect(validJob.location).toBe('Zizers');
      expect(validJob.canton).toBe('GR');
      expect(validJob.postalCode).toBe('7205');
    });

    it('has correct sector for life sciences company', () => {
      expect(validJob.sector).toBe('Scienze della Vita / Biotecnologia');
    });
  });
});

// Only the posting's own text is published (issue 5253): a detail page
// without a body used to be replaced by a stub of card metadata and a company
// sentence ("{title} — INTEGRA Biosciences. Business Area: … Location: …").
// Shapes of integra-biosciences.com (Drupal views table, JSON-LD detail).
describe('fetchAllIntegraBiosciencesJobs — card without a vacancy body', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.JOBS_CRAWLER_DELAY_MS;
  });

  it('publishes the card with a body and skips the one without, never inventing text', async () => {
    process.env.JOBS_CRAWLER_DELAY_MS = '1';
    const row = (slug: string, title: string) => `<tr><td headers="view-title-table-column" class="views-field views-field-title"><a href="/global/en/careers/${slug}" hreflang="en">${title}</a> </td>`
      + '<td headers="view-field-business-area-table-column" class="views-field views-field-field-business-area">Engineering </td>'
      + '<td headers="view-field-job-country-table-column" class="views-field views-field-field-job-country">Switzerland </td></tr>';
    const listing = `<html><body><table class="cols-3"><thead><tr><th id="view-title-table-column">Title</th></tr></thead><tbody>${row('elektronikentwickler-mw-100', 'Elektronikentwickler (m/w | 100%)')}${row('junior-controller-mw-80-100', 'Junior Controller (m/w | 80-100%)')}</tbody></table></body></html>`;
    const detail = (description: string) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', description, datePosted: '2026-09-20' })}</script></head><body>${'<p>page chrome</p>'.repeat(10)}</body></html>`;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/open-positions')) return new Response(listing, { status: 200 });
      if (u.includes('elektronikentwickler')) return new Response(detail('<p>Sie entwickeln Elektronik für unsere Laborgeräte in Zizers, von der Schaltung bis zur Serienreife. Sie arbeiten eng mit Kolleginnen und Kollegen aus mehreren Bereichen zusammen, dokumentieren Ihre Arbeit sorgfältig und bringen Ideen zur Verbesserung der Abläufe ein. Wir bieten flexible Arbeitszeiten, Weiterbildungen und ein kollegiales Team in einem modernen Umfeld.</p>'), { status: 200 });
      return new Response(detail(''), { status: 200 });
    }));

    const jobs = await fetchAllIntegraBiosciencesJobs();
    expect(jobs.map((job) => job.title)).toEqual(['Elektronikentwickler (m/w | 100%)']);
    for (const job of jobs) expect(job.description).not.toMatch(/— INTEGRA Biosciences/);
  }, 20_000);
});

// The live layout (verified through the Jina proxy on 2026-10-01): the
// open-positions page renders its table client-side from
// `drupalSettings.jobsAllData`; the server table is empty and always followed
// by the "no job offers available" panel, while 13 offers (8 in Switzerland)
// are live. Fixtures are the real pages, trimmed (settings reduced to the
// vacancy array; detail contact names and phone numbers replaced).
describe('INTEGRA Biosciences — jobsAllData listing and Umantis detail pages', () => {
  const fixture = (name: string) => readFileSync(
    new URL(`./fixtures/integra-biosciences/${name}`, import.meta.url),
    'utf8',
  );
  const LISTING = fixture('open-positions-jobsalldata.html');
  const DETAIL_EN = fixture('umantis-detail-326-en.html');
  const DETAIL_DE = fixture('umantis-detail-330-de.html');
  const detailFor = (url: string) => (url.includes('/Vacancies/326/') ? DETAIL_EN : DETAIL_DE);

  afterEach(() => {
    delete process.env.JOBS_CRAWLER_DELAY_MS;
  });

  it('reads every offer of the vacancy array, the empty server table notwithstanding', () => {
    expect(parseListingTable(LISTING)).toEqual([]);
    const cards = parseJobsAllData(LISTING)!;
    expect(cards).toHaveLength(13);
    const swiss = cards.filter((card) => card.country === 'Switzerland');
    expect(swiss).toHaveLength(8);
    expect(swiss[0]).toEqual({
      title: 'NGS Sales Specialist (m/f/d | 100%)',
      detailUrl: 'https://jobs.integra-biosciences.com/Vacancies/326/Description/2?lang=eng',
      businessArea: 'Sales & Customer Support',
      country: 'Switzerland',
      postedDate: '2026-08-06T12:42:14.000Z',
      datePosted: '2026-08-06T12:42:14.000Z',
      postingDateSource: 'reported',
    });
    for (const card of cards) expect(isTrustedDomain(card.detailUrl)).toBe(true);
  });

  it('returns null when the page carries no vacancy array (legacy table layout)', () => {
    expect(parseJobsAllData('<table><tbody><tr><td>x</td></tr></tbody></table>')).toBeNull();
    expect(parseJobsAllData('<script type="application/json" data-drupal-selector="drupal-settings-json">{"path":{}}</script>')).toBeNull();
  });

  it('reads the vacancy text of an Umantis detail page without page furniture or commented markup', () => {
    const en = parseDetailPage(DETAIL_EN);
    expect(en.datePosted).toBe('2026-08-06');
    expect(en.description).toContain('What you can expect from the role');
    expect(en.description).toContain('• Drive sales growth in select locations');
    expect(en.description).toContain('What you offer');
    // The German heading the template keeps in a comment, and the comment end.
    expect(en.description).not.toContain('Bist du bereit');
    expect(en.description).not.toContain('-->');
    // Benefits carousel, contact persons and the campus section are not the ad.
    expect(en.description).not.toContain('Jane Doe');
    expect(en.description).not.toContain('INTEGRA Campus');
    expect(en.description).not.toMatch(/&#\d+;/);
    expect(parseDetailLocation(DETAIL_EN)).toBe('Zizers');
    expect(parseDetailLocation(DETAIL_DE)).toBe('Zizers');
    expect(parseDetailPage(DETAIL_DE).description).toContain('Was du mitbringst');
  });

  it('publishes the Swiss offers with their Umantis vacancy URL and body', async () => {
    process.env.JOBS_CRAWLER_DELAY_MS = '1';
    const fetchDetail = vi.fn(async (url: string) => detailFor(url));
    const jobs = await fetchAllIntegraBiosciencesJobs({ fetchListing: async () => LISTING, fetchDetail });

    expect(fetchDetail).toHaveBeenCalledTimes(8);
    expect(jobs).toHaveLength(8);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(8);
    const sales = jobs.find((job) => job.title.startsWith('NGS Sales Specialist'))!;
    expect(sales).toMatchObject({
      url: 'https://jobs.integra-biosciences.com/Vacancies/326/Description/2?lang=eng',
      location: 'Zizers',
      canton: 'GR',
      sourceLang: 'en',
      postedDate: '2026-08-06',
    });
    expect(jobs.find((job) => job.title.startsWith('Plastic Design Engineer'))!.sourceLang).toBe('de');
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('proves a zero only from a complete vacancy array without a Swiss offer', async () => {
    const usOnly = LISTING.replace(/"country":"Switzerland"/g, '"country":"United States"');
    expect(usOnly).not.toBe(LISTING);
    const fetchDetail = vi.fn(async () => '');
    const proven = await fetchAllIntegraBiosciencesJobs({ fetchListing: async () => usOnly, fetchDetail });
    expect(isAuthoritativeEmptySnapshot(proven)).toBe(true);
    expect(authoritativeEmptySnapshotValidator(INTEGRA_BIOSCIENCES_COMPANY_NAME)(proven)).toBe(true);
    expect(fetchDetail).not.toHaveBeenCalled();

    // A listing that could not be read (Cloudflare + Jina both failed) is not a zero.
    const unread = await fetchAllIntegraBiosciencesJobs({ fetchListing: async () => '', fetchDetail });
    expect(unread).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(unread)).toBe(false);
  });

  it('does not stamp the Zizers HQ address on an ad that names another workplace', async () => {
    process.env.JOBS_CRAWLER_DELAY_MS = '1';
    const elsewhere = DETAIL_DE.replace('<h6>Zizers</h6>', '<h6>Basel</h6>');
    expect(elsewhere).not.toBe(DETAIL_DE);
    const jobs = await fetchAllIntegraBiosciencesJobs({
      fetchListing: async () => LISTING,
      fetchDetail: async (url: string) => (url.includes('/Vacancies/330/') ? elsewhere : detailFor(url)),
    });
    expect(jobs).toHaveLength(7);
    expect(jobs.some((job) => job.url.includes('/Vacancies/330/'))).toBe(false);
  });

  it('asks the pipeline for a source-proven zero instead of an EMPTY_OK_CRAWLERS entry', () => {
    const runner = readFileSync(new URL('../scripts/update-integra-biosciences-jobs.mjs', import.meta.url), 'utf8');
    expect(runner).toContain('validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(');
    expect(runner).toContain('allowAuthoritativeEmptySnapshot: true');
    expect(runner).toContain("authoritativeSnapshotScope: 'empty-only'");
    expect(EMPTY_OK_CRAWLERS.has('integra-biosciences')).toBe(false);
  });
});
