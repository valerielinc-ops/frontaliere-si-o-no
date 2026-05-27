/**
 * Tests for the Würth International AG dedicated job crawler.
 *
 * Verifies:
 *   - HTML table listing page parsing
 *   - Detail page parsing (title, attributes, accordion sections)
 *   - Employment type detection
 *   - Date parsing (DD.MM.YYYY -> YYYY-MM-DD)
 *   - Category detection
 *   - Slug generation
 *   - Company job identification
 *   - Trusted domain detection
 *   - Fallback description generation
 */
import { describe, it, expect } from 'vitest';
import {
  parseListingPage,
  parseDetailPage,
  parseDate,
  detectCategory,
  detectEmploymentType,
  buildFallbackDescription,
  isWuerthInternationalJob,
  isTrustedDomain,
  WUERTH_INTERNATIONAL_KEY,
  WUERTH_INTERNATIONAL_COMPANY_NAME,
  WUERTH_INTERNATIONAL_COMPANY_DOMAIN,
} from '../scripts/lib/wuerth-international-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// ── Fixture: Listing page HTML ───────────────────────────────────────────────

const LISTING_HTML = `
<html>
<body>
<table class="full display dataTable nowrap" id="sortableTable9375499" data-id="9375499">
  <thead></thead>
  <tbody>
    <tr>
      <td class="text-wrap">Berufspraktikum Empfang (a)</td>
      <td>Chur</td>
      <td>Auszubildende</td>
      <td style="text-align: right;">
        <a href="Job-details_17088.php">
          <button type="button" class="btn btn-info btn-angepasst">Mehr</button>
        </a>
      </td>
    </tr>
    <tr>
      <td class="text-wrap">Steuerexperte (W/M/D) oder sehr erfahrener Steuerspezialist</td>
      <td>Chur</td>
      <td>Berufserfahrene</td>
      <td style="text-align: right;">
        <a href="Job-details_17216.php">
          <button type="button" class="btn btn-info btn-angepasst">Mehr</button>
        </a>
      </td>
    </tr>
  </tbody>
</table>
</body>
</html>`;

// ── Fixture: Detail page HTML ────────────────────────────────────────────────

const DETAIL_HTML = `
<html lang="de">
<body>
<div class="outer-container hidden_when_searched jobs_jobs_job_template 9375498_section null">
  <div class="container-fluid">
    <div class="row mb-2">
      <div class="col-12">
        <h1 class="hyphens">Steuerexperte (W/M/D) oder sehr erfahrener Steuerspezialist</h1>
      </div>
    </div>
    <div class="row mb-4 small-navigation">
      <div class="col-12 col-md-6">
        <a href="../../../CH-WINT/Karriere/Job-Portal/Bewerbungsformular_Steuerexperte.php" title="Steuerexperte (W/M/D) oder sehr erfahrener Steuerspezialist" target="_self">
          <span class="btn btn-primary">Jetzt bewerben</span>
        </a>
      </div>
    </div>
    <div class="row mb-2 mb-md-3">
      <div class="atribute-container col-12">
        <span class="mr-4"><i class="icon-location-pin text-primary mr-2"></i> Chur</span>
        <span class="mr-4"><i class="icon-interface-clock-b text-primary mr-2"></i>Vollzeit</span>
        <span class="mr-4"><i class="icon-interface-calendar text-primary mr-2"></i>Erschienen am: 26.03.2026</span>
      </div>
    </div>
    <div class="row mb-3">
      <div class="col-12">
        <div class="row mb-3">
          <div class="col-12 col-md-10 offset-md-1">
            <p>Die Wuerth International Gruppe ist in den Laendern China, Schweiz, Singapur, Slowakei und USA vertreten und betreut von dort aus die Zentraleinkaufsaktivitaeten des Wuerth Konzerns in rund 80 Laendern.</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<div class="outer-container hidden_when_searched jobs_jobs_job_template 9375498_section mb-3">
  <div class="container-fluid">
    <div class="highlight-container">
      <div class="row">
        <div class="col-12">
          <div class="accordion" id="accordion9375498">
            <div class="card card-gray mb-1">
              <button class="card-header w-100 card-header-accordion p-4 border border-bottom-0">
                <div class="row">
                  <div class="col-11">
                    <div class="font-weight-bold text-body d-flex mb-2">IHRE AUFGABEN</div>
                  </div>
                </div>
              </button>
              <div class="collapse show">
                <div class="card-body bg-white p-4">
                  <div class="row mb-3">
                    <div class="col-12 col-md-10 offset-md-1">
                      <ul>
                        <li class="bulletList">Beratung der Geschaeftspartner und der Geschaeftsleitungen sowie Unterstuetzung in allen direktsteuerlichen Belangen</li>
                        <li class="bulletList">Erledigung anspruchsvoller Steuercompliance sowie Beratungstaetigkeiten der in der Schweiz angesiedelten Gesellschaften der Wuerth-Gruppe</li>
                        <li class="bulletList">Steuerliche Betreuung von Umstrukturierungen national und auch international bei Akquisitionen Sanierungen Zusammenschluessen</li>
                        <li class="bulletList">Projektbezogene steuerliche Analysen und Beratungen von konzerninternen und grenzueberschreitenden Sachverhalten</li>
                        <li class="bulletList">Koordination von Steuerpruefungen in der Schweiz</li>
                        <li class="bulletList">Schulung und Unterstuetzung von Teamkolleginnen und Teamkollegen</li>
                        <li class="bulletList">Ausarbeitung von Einsprachen und Steuergutachten</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="card card-gray mb-1">
              <button class="card-header w-100 card-header-accordion p-4 border border-bottom-0">
                <div class="row">
                  <div class="col-11">
                    <div class="font-weight-bold text-body d-flex mb-2">DAS BRINGEN SIE MIT</div>
                  </div>
                </div>
              </button>
              <div class="collapse show">
                <div class="card-body bg-white p-4">
                  <div class="row mb-3">
                    <div class="col-12 col-md-10 offset-md-1">
                      <ul>
                        <li class="bulletList">Bachelor- oder Masterstudium mit mehreren Jahren Berufserfahrung im Bereich des nationalen und internationalen Steuerrechts</li>
                        <li class="bulletList">Idealerweise Steuerexperte oder langjaehrige nationale und internationale Erfahrung</li>
                        <li class="bulletList">Analytisches und betriebswirtschaftliches Denkvermoegen</li>
                        <li class="bulletList">IT-Affinitaet SAP-Kenntnisse von Vorteil</li>
                        <li class="bulletList">Fliessende Deutsch- und Englischkenntnisse jede weitere Fremdsprache von Vorteil</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="card card-gray mb-1">
              <button class="card-header w-100 card-header-accordion p-4 border border-bottom-0">
                <div class="row">
                  <div class="col-11">
                    <div class="font-weight-bold text-body d-flex mb-2">DAS BIETEN WIR</div>
                  </div>
                </div>
              </button>
              <div class="collapse show">
                <div class="card-body bg-white p-4">
                  <div class="row mb-3">
                    <div class="col-12 col-md-10 offset-md-1">
                      <ul>
                        <li class="bulletList">Flexible Arbeitszeitgestaltung und hybride Arbeitsmodelle</li>
                        <li class="bulletList">Interessante Weiterbildungsprogramme</li>
                        <li class="bulletList">Ueberdurchschnittliche Sozialleistungen</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

describe('Wuerth International crawler constants', () => {
  it('has correct company key', () => {
    expect(WUERTH_INTERNATIONAL_KEY).toBe('wuerth-international');
  });

  it('has correct company name', () => {
    expect(WUERTH_INTERNATIONAL_COMPANY_NAME).toBe('Würth International');
  });

  it('has correct company domain', () => {
    expect(WUERTH_INTERNATIONAL_COMPANY_DOMAIN).toBe('wurth-international.com');
  });
});

// ═══════════════════════════════════════════════════════════════════
// parseListingPage
// ═══════════════════════════════════════════════════════════════════

describe('parseListingPage', () => {
  it('extracts all job listings from table', () => {
    const jobs = parseListingPage(LISTING_HTML);
    expect(jobs).toHaveLength(2);
  });

  it('extracts job titles', () => {
    const jobs = parseListingPage(LISTING_HTML);
    expect(jobs[0].title).toBe('Berufspraktikum Empfang (a)');
    expect(jobs[1].title).toContain('Steuerexperte');
  });

  it('extracts job locations', () => {
    const jobs = parseListingPage(LISTING_HTML);
    expect(jobs[0].location).toBe('Chur');
    expect(jobs[1].location).toBe('Chur');
  });

  it('extracts entry level', () => {
    const jobs = parseListingPage(LISTING_HTML);
    expect(jobs[0].entryLevel).toBe('Auszubildende');
    expect(jobs[1].entryLevel).toBe('Berufserfahrene');
  });

  it('generates full detail URLs', () => {
    const jobs = parseListingPage(LISTING_HTML);
    expect(jobs[0].url).toContain('Job-details_17088.php');
    expect(jobs[1].url).toContain('Job-details_17216.php');
    for (const job of jobs) {
      expect(job.url).toMatch(/^https:\/\//);
    }
  });

  it('deduplicates by URL', () => {
    const duplicateHtml = LISTING_HTML.replace('</tbody>', `
      <tr>
        <td class="text-wrap">Berufspraktikum Empfang (a)</td>
        <td>Chur</td>
        <td>Auszubildende</td>
        <td style="text-align: right;">
          <a href="Job-details_17088.php">
            <button type="button" class="btn">Mehr</button>
          </a>
        </td>
      </tr>
    </tbody>`);
    const jobs = parseListingPage(duplicateHtml);
    expect(jobs).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(parseListingPage('')).toHaveLength(0);
    expect(parseListingPage(null as unknown as string)).toHaveLength(0);
  });

  it('returns empty for page without job table', () => {
    expect(parseListingPage('<html><body><p>No jobs</p></body></html>')).toHaveLength(0);
  });

  it('skips rows with very short titles', () => {
    const html = `
    <table id="sortableTable9375499">
      <tbody>
        <tr>
          <td>AB</td>
          <td>Chur</td>
          <td>Test</td>
          <td><a href="Job-details_1.php"><button>Mehr</button></a></td>
        </tr>
      </tbody>
    </table>`;
    expect(parseListingPage(html)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// parseDetailPage
// ═══════════════════════════════════════════════════════════════════

describe('parseDetailPage', () => {
  it('extracts title from h1', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('Steuerexperte');
  });

  it('extracts location from attributes', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.location).toBe('Chur');
  });

  it('detects employment type', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.employmentType).toBe('FULL_TIME');
  });

  it('parses posted date', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.postedDate).toBe('2026-03-26');
  });

  it('extracts apply URL', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.applyUrl).toContain('Bewerbungsformular');
  });

  it('extracts description from accordion sections', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.description).toBeTruthy();
    expect(result!.description.length).toBeGreaterThan(100);
  });

  it('description contains tasks content', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.description).toContain('Beratung');
  });

  it('description contains requirements content', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.description).toContain('Bachelor');
  });

  it('extracts section headings', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.headings).toContain('IHRE AUFGABEN');
    expect(result!.headings).toContain('DAS BRINGEN SIE MIT');
    expect(result!.headings).toContain('DAS BIETEN WIR');
  });

  it('returns null for empty input', () => {
    expect(parseDetailPage('')).toBeNull();
    expect(parseDetailPage(null as unknown as string)).toBeNull();
  });

  it('returns null for page without h1', () => {
    expect(parseDetailPage('<html><body><p>No title</p></body></html>')).toBeNull();
  });

  it('detects Teilzeit employment type', () => {
    const teilzeitHtml = DETAIL_HTML.replace('Vollzeit', 'Teilzeit');
    const result = parseDetailPage(teilzeitHtml);
    expect(result!.employmentType).toBe('PART_TIME');
  });
});

// ═══════════════════════════════════════════════════════════════════
// parseDate
// ═══════════════════════════════════════════════════════════════════

describe('parseDate (DD.MM.YYYY -> YYYY-MM-DD)', () => {
  it('parses standard date', () => {
    expect(parseDate('26.03.2026')).toBe('2026-03-26');
  });

  it('parses date with leading zeros', () => {
    expect(parseDate('01.01.2026')).toBe('2026-01-01');
  });

  it('parses date without leading zeros', () => {
    expect(parseDate('4.3.2026')).toBe('2026-03-04');
  });

  it('returns empty for invalid format', () => {
    expect(parseDate('2026-03-26')).toBe('');
    expect(parseDate('March 26, 2026')).toBe('');
  });

  it('returns empty for empty input', () => {
    expect(parseDate('')).toBe('');
    expect(parseDate(undefined as unknown as string)).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// detectCategory
// ═══════════════════════════════════════════════════════════════════

describe('detectCategory', () => {
  it('detects tax/finance roles', () => {
    expect(detectCategory('Steuerexperte', '')).toBe('finance');
  });

  it('detects finance/controlling', () => {
    expect(detectCategory('Financial Controller', '')).toBe('finance');
  });

  it('detects procurement/logistics', () => {
    expect(detectCategory('Einkäufer Beschaffung', '')).toBe('logistics');
  });

  it('detects IT/technology', () => {
    expect(detectCategory('SAP Consultant', '')).toBe('technology');
  });

  it('detects internship/apprentice', () => {
    expect(detectCategory('Berufspraktikum Empfang', '')).toBe('internship');
  });

  it('detects administration', () => {
    expect(detectCategory('Kaufmännische Assistenz', '')).toBe('administration');
  });

  it('defaults to administration for unknown', () => {
    expect(detectCategory('Generic Position', '')).toBe('administration');
  });
});

// ═══════════════════════════════════════════════════════════════════
// detectEmploymentType
// ═══════════════════════════════════════════════════════════════════

describe('detectEmploymentType', () => {
  it('detects Vollzeit as FULL_TIME', () => {
    expect(detectEmploymentType('Vollzeit')).toBe('FULL_TIME');
  });

  it('detects Teilzeit as PART_TIME', () => {
    expect(detectEmploymentType('Teilzeit')).toBe('PART_TIME');
  });

  it('defaults to FULL_TIME for unknown', () => {
    expect(detectEmploymentType('')).toBe('FULL_TIME');
    expect(detectEmploymentType('Andere')).toBe('FULL_TIME');
  });
});

// ═══════════════════════════════════════════════════════════════════
// isWuerthInternationalJob
// ═══════════════════════════════════════════════════════════════════

describe('isWuerthInternationalJob detection', () => {
  it('identifies by companyKey', () => {
    expect(isWuerthInternationalJob({ companyKey: 'wuerth-international' })).toBe(true);
  });

  it('identifies by company name (with umlaut)', () => {
    expect(isWuerthInternationalJob({ company: 'Würth International' })).toBe(true);
  });

  it('identifies by company name (without umlaut)', () => {
    expect(isWuerthInternationalJob({ company: 'Wuerth International' })).toBe(true);
  });

  it('identifies by company name (simplified)', () => {
    expect(isWuerthInternationalJob({ company: 'Wurth International AG' })).toBe(true);
  });

  it('identifies by URL', () => {
    expect(isWuerthInternationalJob({ url: 'https://www.wurth-international.com/karriere/job/123' })).toBe(true);
  });

  it('rejects non-Wuerth jobs', () => {
    expect(isWuerthInternationalJob({ companyKey: 'lonza', company: 'Lonza', url: 'https://lonza.com/job/123' })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// isTrustedDomain
// ═══════════════════════════════════════════════════════════════════

describe('isTrustedDomain', () => {
  it('trusts www.wurth-international.com', () => {
    expect(isTrustedDomain('https://www.wurth-international.com/karriere/job')).toBe(true);
  });

  it('trusts wurth-international.com', () => {
    expect(isTrustedDomain('https://wurth-international.com/karriere/job')).toBe(true);
  });

  it('trusts subdomains', () => {
    expect(isTrustedDomain('https://jobs.wurth-international.com/details')).toBe(true);
  });

  it('rejects untrusted domains', () => {
    expect(isTrustedDomain('https://malicious-site.com/wurth-international')).toBe(false);
  });

  it('rejects wuerth.com (different domain)', () => {
    expect(isTrustedDomain('https://www.wuerth.com/karriere')).toBe(false);
  });

  it('handles invalid URLs gracefully', () => {
    expect(isTrustedDomain('not-a-url')).toBe(false);
    expect(isTrustedDomain('')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// buildFallbackDescription
// ═══════════════════════════════════════════════════════════════════

describe('buildFallbackDescription', () => {
  it('generates description with >=50 words', () => {
    const desc = buildFallbackDescription('Steuerexperte', 'Chur', 'Berufserfahrene');
    const wordCount = desc.split(/\s+/).length;
    expect(wordCount).toBeGreaterThanOrEqual(50);
  });

  it('includes job title', () => {
    const desc = buildFallbackDescription('Einkäufer', 'Chur');
    expect(desc).toContain('Einkäufer');
  });

  it('includes location', () => {
    const desc = buildFallbackDescription('Test Job', 'Chur');
    expect(desc).toContain('Chur');
  });

  it('includes company info', () => {
    const desc = buildFallbackDescription('Test Job', 'Chur');
    expect(desc).toContain('Würth International');
  });

  it('includes entry level when provided', () => {
    const desc = buildFallbackDescription('Test Job', 'Chur', 'Auszubildende');
    expect(desc).toContain('Auszubildende');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Slug generation
// ═══════════════════════════════════════════════════════════════════

describe('slug generation', () => {
  it('generates slug for German job title', () => {
    const slug = slugify('Steuerexperte wuerth-international Chur');
    expect(slug).toBe('steuerexperte-wuerth-international-chur');
  });

  it('handles umlauts correctly', () => {
    const slug = slugify('Einkäufer Büromaterial wuerth-international Chur');
    expect(slug).toContain('einkaufer');
    expect(slug).toContain('buromaterial');
  });

  it('truncates to max 90 characters', () => {
    const longTitle = 'A'.repeat(100);
    const slug = slugify(longTitle);
    expect(slug.length).toBeLessThanOrEqual(90);
  });
});
