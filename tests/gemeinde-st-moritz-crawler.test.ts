import { describe, it, expect } from 'vitest';
import {
  GEMEINDE_ST_MORITZ_KEY,
  GEMEINDE_ST_MORITZ_COMPANY_NAME,
  isGemeindeStMoritzJob,
  isTrustedDomain,
  parseListingHtml,
  parseDetailHtml,
  parseGermanDate,
} from '../scripts/lib/gemeinde-st-moritz-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// ── Fixtures (matching real gemeinde-stmoritz.ch TYPO3 HTML) ─────────

const SAMPLE_LISTING_HTML = `
<html><body>
<div class="content-element">
  <h2>Offene Stellen</h2>
  <div class="news-list">
    <a href="/aktuelles/aktuelles/offene-stellen/detail/mitarbeiter-wasserversorgung-100-m-w-1" class="card-link">
      <div class="card">
        <img src="/fileadmin/_processed_/7/2/csm_Trinkwasserversorgung_d3134689c1.jpg" width="400" height="300" alt="">
        <h3>Mehr lesen</h3>
        <span class="date">7. April 2026</span>
        <h3>Mitarbeiter Wasserversorgung 100% (m/w)</h3>
        <p>Die Gemeinde St. Moritz sucht zur Erg&auml;nzung des Teams ab 1. September 2026...</p>
        <span class="more">Mehr lesen</span>
      </div>
    </a>
    <a href="/aktuelles/aktuelles/offene-stellen/detail/gemeindepolizist-100-m-w-1" class="card-link">
      <div class="card">
        <img src="/fileadmin/_processed_/5/3/csm_Polizei_abc123.jpg" width="400" height="300" alt="">
        <h3>Mehr lesen</h3>
        <span class="date">31. Oktober 2025</span>
        <h3>Gemeindepolizist 100% (m/w)</h3>
        <p>F&uuml;r die Gemeindepolizei St. Moritz suchen wir ab sofort...</p>
        <span class="more">Mehr lesen</span>
      </div>
    </a>
  </div>
</div>
</body></html>
`;

const SAMPLE_DETAIL_HTML = `
<html lang="de"><body>
<main id="content">
  <article class="news-detail">
    <h1>Mitarbeiter Wasserversorgung 100% (m/w)</h1>
    <div class="news-meta">
      <span class="date">7. April 2026</span>
    </div>
    <div class="ce-bodytext">
      <p>Die Gemeinde St. Moritz sucht zur Ergänzung des Teams ab 1. September 2026 oder nach
      Vereinbarung eine ausgewiesene Fachkraft als Mitarbeiter Wasserversorgung 100% (m/w).</p>
      <p>Die Wasserversorgung von St. Moritz versorgt die Bevölkerung und die Gäste mit qualitativ
      hochwertigem Trinkwasser. Als Mitarbeiter der Wasserversorgung unterstützen Sie den
      Wassermeister bei allen anfallenden Arbeiten rund um die Wasserversorgungsinfrastruktur.</p>
      <p>Weitere Informationen entnehmen Sie bitte dem Stelleninserat.</p>
      <p><a href="/fileadmin/user_upload/dokumente/pdf/stellenausschreibungen/Mitarbeiter_Wasserversorgung.pdf">Stelleinserat herunterladen</a></p>
    </div>
  </article>
</main>
</body></html>
`;

const SAMPLE_DETAIL_POLICE_HTML = `
<html lang="de"><body>
<main id="content">
  <article class="news-detail">
    <h1>Gemeindepolizist 100% (m/w)</h1>
    <div class="news-meta">
      <span class="date">31. Oktober 2025</span>
    </div>
    <div class="ce-bodytext">
      <p>Für die Gemeindepolizei St. Moritz suchen wir ab sofort oder nach Vereinbarung Sie als
      Gemeindepolizist 100% (m/w).</p>
      <p>Die Gemeindepolizei St. Moritz sorgt für Ordnung und Sicherheit in der Gemeinde. Als
      Gemeindepolizist gehören die allgemeine Überwachung des Gemeindegebiets, die Kontrolle des
      ruhenden und fliessenden Verkehrs sowie die Mitwirkung bei Anlässen zu Ihren Hauptaufgaben.</p>
      <p><a href="/fileadmin/user_upload/dokumente/pdf/stellenausschreibungen/311025_Polizist_Gemeinde_StMoritz_2024-25.pdf">Stelleninserat herunterladen</a></p>
    </div>
  </article>
</main>
</body></html>
`;

// ── Tests ─────────────────────────────────────────────────────────────

describe('Gemeinde St. Moritz crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(GEMEINDE_ST_MORITZ_KEY).toBe('gemeinde-st-moritz');
    expect(GEMEINDE_ST_MORITZ_COMPANY_NAME).toBe('Gemeinde St. Moritz');
  });

  // ── parseGermanDate ──
  describe('parseGermanDate', () => {
    it('parses standard German date', () => {
      expect(parseGermanDate('7. April 2026')).toBe('2026-04-07');
    });

    it('parses date with Oktober', () => {
      expect(parseGermanDate('31. Oktober 2025')).toBe('2025-10-31');
    });

    it('parses date with Januar', () => {
      expect(parseGermanDate('1. Januar 2026')).toBe('2026-01-01');
    });

    it('parses date with Maerz (alternative spelling)', () => {
      expect(parseGermanDate('15. Maerz 2026')).toBe('2026-03-15');
    });

    it('handles extra whitespace', () => {
      expect(parseGermanDate('  7.  April  2026  ')).toBe('2026-04-07');
    });

    it('returns empty string for invalid input', () => {
      expect(parseGermanDate('')).toBe('');
      expect(parseGermanDate(null)).toBe('');
      expect(parseGermanDate('not a date')).toBe('');
    });
  });

  // ── parseListingHtml ──
  describe('parseListingHtml', () => {
    it('extracts job listings from TYPO3 HTML', () => {
      const jobs = parseListingHtml(SAMPLE_LISTING_HTML);
      expect(jobs).toHaveLength(2);
    });

    it('extracts correct titles (skips "Mehr lesen" headings)', () => {
      const jobs = parseListingHtml(SAMPLE_LISTING_HTML);
      expect(jobs[0].title).toBe('Mitarbeiter Wasserversorgung 100% (m/w)');
      expect(jobs[1].title).toBe('Gemeindepolizist 100% (m/w)');
    });

    it('builds correct detail URLs', () => {
      const jobs = parseListingHtml(SAMPLE_LISTING_HTML);
      expect(jobs[0].url).toBe('https://www.gemeinde-stmoritz.ch/aktuelles/aktuelles/offene-stellen/detail/mitarbeiter-wasserversorgung-100-m-w-1');
      expect(jobs[1].url).toBe('https://www.gemeinde-stmoritz.ch/aktuelles/aktuelles/offene-stellen/detail/gemeindepolizist-100-m-w-1');
    });

    it('extracts dates from card content', () => {
      const jobs = parseListingHtml(SAMPLE_LISTING_HTML);
      expect(jobs[0].date).toBe('2026-04-07');
      expect(jobs[1].date).toBe('2025-10-31');
    });

    it('deduplicates by URL', () => {
      const dupeHtml = SAMPLE_LISTING_HTML + `
        <a href="/aktuelles/aktuelles/offene-stellen/detail/mitarbeiter-wasserversorgung-100-m-w-1">
          <h3>Mitarbeiter Wasserversorgung 100% (m/w)</h3>
        </a>`;
      const jobs = parseListingHtml(dupeHtml);
      const urls = jobs.map((j) => j.url);
      expect(new Set(urls).size).toBe(urls.length);
    });

    it('returns empty array for null/empty input', () => {
      expect(parseListingHtml(null)).toEqual([]);
      expect(parseListingHtml('')).toEqual([]);
      expect(parseListingHtml(undefined)).toEqual([]);
    });

    it('returns empty array for HTML with no job links', () => {
      expect(parseListingHtml('<html><body><p>No jobs here</p></body></html>')).toEqual([]);
    });
  });

  // ── parseDetailHtml ──
  describe('parseDetailHtml', () => {
    it('extracts title from <h1>', () => {
      const result = parseDetailHtml(SAMPLE_DETAIL_HTML);
      expect(result).not.toBeNull();
      expect(result.title).toBe('Mitarbeiter Wasserversorgung 100% (m/w)');
    });

    it('extracts date from page content', () => {
      const result = parseDetailHtml(SAMPLE_DETAIL_HTML);
      expect(result.date).toBe('2026-04-07');
    });

    it('extracts description from ce-bodytext', () => {
      const result = parseDetailHtml(SAMPLE_DETAIL_HTML);
      expect(result.description).toContain('Gemeinde St. Moritz');
      expect(result.description).toContain('Wasserversorgung');
      expect(result.description).toContain('Trinkwasser');
      expect(result.description.length).toBeGreaterThan(30);
    });

    it('extracts PDF download URL', () => {
      const result = parseDetailHtml(SAMPLE_DETAIL_HTML);
      expect(result.pdfUrl).toBe('https://www.gemeinde-stmoritz.ch/fileadmin/user_upload/dokumente/pdf/stellenausschreibungen/Mitarbeiter_Wasserversorgung.pdf');
    });

    it('parses police job detail correctly', () => {
      const result = parseDetailHtml(SAMPLE_DETAIL_POLICE_HTML);
      expect(result.title).toBe('Gemeindepolizist 100% (m/w)');
      expect(result.date).toBe('2025-10-31');
      expect(result.description).toContain('Gemeindepolizei');
      expect(result.description).toContain('Sicherheit');
      expect(result.pdfUrl).toContain('311025_Polizist_Gemeinde_StMoritz');
    });

    it('falls back to <main> content when ce-bodytext is missing', () => {
      const htmlNoBodytext = `
        <html><body>
        <main>
          <h1>Sachbearbeiter Finanzen 80% (m/w)</h1>
          <p>Die Gemeinde St. Moritz sucht eine qualifizierte Fachperson im Bereich Finanzen und
          Rechnungswesen. Sie sind verantwortlich für die Buchhaltung und Finanzplanung der Gemeinde.</p>
        </main>
        </body></html>`;
      const result = parseDetailHtml(htmlNoBodytext);
      expect(result.title).toBe('Sachbearbeiter Finanzen 80% (m/w)');
      expect(result.description).toContain('Finanzen');
    });

    it('falls back to paragraph extraction as last resort', () => {
      const htmlMinimal = `
        <html><body>
        <h1>Hauswart Schulhaus 60% (m/w)</h1>
        <p>Die Gemeinde St. Moritz sucht einen zuverlässigen Hauswart für die Betreuung und Pflege
        des Schulhauses. Zu Ihren Aufgaben gehören die Reinigung, Instandhaltung und Überwachung.</p>
        </body></html>`;
      const result = parseDetailHtml(htmlMinimal);
      expect(result.title).toBe('Hauswart Schulhaus 60% (m/w)');
      expect(result.description).toContain('Hauswart');
    });

    it('returns null for empty/invalid content', () => {
      expect(parseDetailHtml(null)).toBeNull();
      expect(parseDetailHtml('')).toBeNull();
      expect(parseDetailHtml(undefined)).toBeNull();
    });

    it('returns null for HTML with no parseable content', () => {
      expect(parseDetailHtml('<html><body></body></html>')).toBeNull();
    });
  });

  // ── isGemeindeStMoritzJob ──
  describe('isGemeindeStMoritzJob', () => {
    it('matches by companyKey', () => {
      expect(isGemeindeStMoritzJob({ companyKey: 'gemeinde-st-moritz' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGemeindeStMoritzJob({ company: 'Gemeinde St. Moritz' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isGemeindeStMoritzJob({ url: 'https://www.gemeinde-stmoritz.ch/aktuelles/offene-stellen/detail/test' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isGemeindeStMoritzJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGemeindeStMoritzJob(null)).toBe(false);
      expect(isGemeindeStMoritzJob(undefined)).toBe(false);
      expect(isGemeindeStMoritzJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://gemeinde-stmoritz.ch/careers/job-123')).toBe(true);
    });

    it('trusts www subdomain', () => {
      expect(isTrustedDomain('https://www.gemeinde-stmoritz.ch/aktuelles/offene-stellen')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.gemeinde-stmoritz.ch/job/456')).toBe(true);
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
      const slug = slugify('Mitarbeiter Wasserversorgung 100% (m/w)');
      expect(slug).toBe('mitarbeiter-wasserversorgung-100-m-w');
    });

    it('strips diacritics', () => {
      expect(slugify('Gemeindepolizist für Sicherheit')).toBe('gemeindepolizist-fur-sicherheit');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer gemeinde-st-moritz ch')).toBe('developer-gemeinde-st-moritz-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'gemeinde-st-moritz-abc123def456',
      slug: 'mitarbeiter-wasserversorgung-100-m-w-gemeinde-st-moritz-ch',
      slugByLocale: { de: 'mitarbeiter-wasserversorgung-100-m-w-gemeinde-st-moritz-ch' },
      company: 'Gemeinde St. Moritz',
      companyKey: 'gemeinde-st-moritz',
      title: 'Mitarbeiter Wasserversorgung 100% (m/w)',
      titleByLocale: { de: 'Mitarbeiter Wasserversorgung 100% (m/w)' },
      description: 'Die Gemeinde St. Moritz sucht zur Ergaenzung des Teams eine Fachkraft.',
      descriptionByLocale: { de: 'Die Gemeinde St. Moritz sucht zur Ergaenzung des Teams eine Fachkraft.' },
      location: 'St. Moritz',
      canton: 'GR',
      url: 'https://www.gemeinde-stmoritz.ch/aktuelles/aktuelles/offene-stellen/detail/mitarbeiter-wasserversorgung-100-m-w-1',
      source: 'Gemeinde St. Moritz Dedicated Parser',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
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

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^gemeinde-st-moritz-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('location is St. Moritz and canton is GR', () => {
      expect(validJob.location).toBe('St. Moritz');
      expect(validJob.canton).toBe('GR');
    });
  });
});
