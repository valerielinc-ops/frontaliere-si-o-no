import { describe, it, expect } from 'vitest';
import {
  HIRSLANDEN_KEY,
  HIRSLANDEN_COMPANY_NAME,
  isHirslandenJob,
  isTrustedDomain,
  parseSearchResults,
  parseDetailPage,
  descriptionBodyToMarkdown,
} from '../scripts/lib/hirslanden-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Hirslanden Klinik crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(HIRSLANDEN_KEY).toBe('hirslanden');
    expect(HIRSLANDEN_COMPANY_NAME).toBe('Hirslanden Klinik');
  });

  // ── isCompanyJob ──
  describe('isHirslandenJob', () => {
    it('matches by companyKey', () => {
      expect(isHirslandenJob({ companyKey: 'hirslanden' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isHirslandenJob({ company: 'Hirslanden Klinik' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isHirslandenJob({ url: 'https://hirslanden.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isHirslandenJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isHirslandenJob(null)).toBe(false);
      expect(isHirslandenJob(undefined)).toBe(false);
      expect(isHirslandenJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://hirslanden.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.hirslanden.ch/job/456')).toBe(true);
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
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer hirslanden ch')).toBe('developer-hirslanden-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'hirslanden-abc123',
      slug: 'test-position-hirslanden-ch',
      slugByLocale: { de: 'test-position-hirslanden-ch' },
      company: 'Hirslanden Klinik',
      companyKey: 'hirslanden',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://hirslanden.ch/jobs/test',
      source: 'Hirslanden Klinik Dedicated Parser',
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
      expect(validJob.id).toMatch(/^hirslanden-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── parseSearchResults: layout handling ──
  describe('parseSearchResults', () => {
    it('parses the legacy <tr>/<td> table layout', () => {
      const html = `
        <table>
          <tr>
            <td><a href="/Hirslanden/job/Some-Role-Zurich-8008/111/">Dipl. Pflegefachfrau</a></td>
            <td>Zürich</td>
            <td>2026-06-01</td>
          </tr>
        </table>`;
      const jobs = parseSearchResults(html);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobId).toBe('111');
      expect(jobs[0].title).toBe('Dipl. Pflegefachfrau');
      expect(jobs[0].location).toBe('Zürich');
      expect(jobs[0].url).toContain('/Hirslanden/job/Some-Role-Zurich-8008/111/');
    });

    it('falls back to the div-based tile layout (current SF skin)', () => {
      // careers.mediclinic.com migrated away from <tr> rows to job tiles.
      const html = `
        <div class="job-row">
          <span class="section-title title" role="heading">
            <a class="jobTitle-link fontcolorc63bfd23" data-focus-tile=".job-id-1293595201"
               href="/Hirslanden/job/Hirslanden-Klinik-St_-Anna-Luze-6003/1293595201/">
               Dipl. Expertin / Experte Anästhesiepflege NDS (a) 80-100%
            </a>
          </span>
          <div id="job-1293595201-desktop-section-customfield5-value">Luzern</div>
          <!-- tablet variant repeats the same job -->
          <a class="jobTitle-link" href="/Hirslanden/job/Hirslanden-Klinik-St_-Anna-Luze-6003/1293595201/">
            Dipl. Expertin / Experte Anästhesiepflege NDS (a) 80-100%
          </a>
        </div>`;
      const jobs = parseSearchResults(html);
      expect(jobs).toHaveLength(1); // deduped across tile variants
      expect(jobs[0].jobId).toBe('1293595201');
      expect(jobs[0].title).toContain('Anästhesiepflege');
      expect(jobs[0].location).toBe('Luzern');
      expect(jobs[0].url).toContain('/Hirslanden/job/');
    });

    it('matches tile anchors regardless of class/href attribute order', () => {
      // A future SF skin could emit `href` before `class`; the lookahead-based
      // linkRe must not depend on `class` preceding `href` (would zero-match).
      const html = `
        <div class="job-row">
          <a data-focus-tile=".job-id-555" href="/Hirslanden/job/Some-Role-Bern-3000/555/"
             class="jobTitle-link fontcolorc63bfd23">
             Fachperson Operationstechnik (a) 100%
          </a>
          <div id="job-555-desktop-section-customfield5-value">Bern</div>
        </div>`;
      const jobs = parseSearchResults(html);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobId).toBe('555');
      expect(jobs[0].title).toContain('Operationstechnik');
      expect(jobs[0].location).toBe('Bern');
    });

    it('returns empty array for HTML with no job links', () => {
      expect(parseSearchResults('<div>Keine Ergebnisse</div>')).toEqual([]);
      expect(parseSearchResults('')).toEqual([]);
    });
  });

  describe('parseDetailPage', () => {
    // Mirrors the real careers.mediclinic.com SF skin: a page-level
    // <div id="content"> chrome wrapper holding the search/job-alert widget,
    // and the REAL per-job body inside <span itemprop="description"> with its
    // <h2>/<ul><li> blocks nested in styled <div>s. Scraping #content gave the
    // same chrome for every job → boilerplate fallback → duplicate-listings.
    const detailHtml = (title: string, aufgabe: string, profil: string) => `
      <html><body>
        <div id="content" tabindex="-1" class="contentHirslanden" role="main">
          <div class="inner"><div id="search-wrapper">
            <form class="jobAlertsSearchForm"><input name="keywords"></form>
            <h2>Suche nach Stichwort</h2>
          </div></div>
        </div>
        <h1><span itemprop="title" data-careersite-propertyid="title">${title}</span></h1>
        <span itemprop="description" data-careersite-propertyid="description">
          <span class="jobdescription">
            <p>Arbeitsort: Hirslanden Klinik Aarau&#160; | Aarau&#160;</p>
            <p>Referenznummer: 66992</p>
            <div><div style="font-size:16px"><h2 style="margin:0"><b>DEINE AUFGABEN</b></h2></div>
              <div><ul><li>${aufgabe}</li></ul></div></div>
            <div><div><h2><b>DEIN PROFIL</b></h2></div>
              <div><ul><li>${profil}</li></ul></div></div>
            <p>Für zusätzliche Informationen steht dir Erika Musterfrau unter T +41 62 836 71 68 gerne zur Verfügung.</p>
          </span>
        </span>
        <a href="/talentcommunity/apply/66992/?locale=de_DE">Bewerben</a>
      </body></html>`;

    it('extracts the real job title from itemprop="title", not the <h2> section heading', () => {
      const d = parseDetailPage(detailHtml('OP-Lagerungspfleger (a) 100%', 'OP-Bereitschaft', 'Grundausbildung'));
      expect(d?.title).toBe('OP-Lagerungspfleger (a) 100%');
      expect(d?.title).not.toMatch(/AUFGABEN|PROFIL/);
    });

    it('extracts the per-job description from itemprop="description", not the #content chrome wrapper', () => {
      const d = parseDetailPage(detailHtml('Pflegefachperson', 'Pflege leisten', 'Diplom Pflege'));
      expect(d?.description).toContain('Pflege leisten');
      expect(d?.description).toContain('Diplom Pflege');
      // Chrome from the #content search widget must NOT leak in.
      expect(d?.description).not.toMatch(/Suche nach Stichwort/);
    });

    it('yields DISTINCT descriptions for distinct jobs (no duplicate-listings collapse)', () => {
      const a = parseDetailPage(detailHtml('Job A', 'Aufgabe A spezifisch', 'Profil A'));
      const b = parseDetailPage(detailHtml('Job B', 'Aufgabe B spezifisch', 'Profil B'));
      expect(a?.description).not.toBe(b?.description);
      expect(a?.title).not.toBe(b?.title);
    });

    it('preserves <h2> headings as ## and <ul><li> as - bullets (structured content)', () => {
      const d = parseDetailPage(detailHtml('Rolle', 'Erste Aufgabe', 'Erste Anforderung'));
      expect(d?.description).toMatch(/^## DEINE AUFGABEN$/m);
      expect(d?.description).toMatch(/^## DEIN PROFIL$/m);
      expect(d?.description).toMatch(/^- Erste Aufgabe$/m);
      expect(d?.description).toMatch(/^- Erste Anforderung$/m);
    });

    it('strips recruiter direct-phone PII from the description', () => {
      const d = parseDetailPage(detailHtml('Rolle', 'Aufgabe', 'Profil'));
      expect(d?.description).not.toMatch(/\+41\s*62\s*836/);
    });

    it('parses the apply URL', () => {
      const d = parseDetailPage(detailHtml('Rolle', 'Aufgabe', 'Profil'));
      expect(d?.applyUrl).toContain('/talentcommunity/apply/66992/');
    });

    it('returns null for empty/invalid input', () => {
      expect(parseDetailPage('')).toBeNull();
      // @ts-expect-error testing non-string input
      expect(parseDetailPage(null)).toBeNull();
    });

    it('ignores a competing <meta itemprop> in <head> and reads the body span (#1885)', () => {
      // If the SF skin ever ships a void `<meta itemprop="title|description">`
      // in <head>, an unscoped `[itemprop=...]` selector returns it first by
      // document order (head before body) — its textContent/innerHTML is empty,
      // so title goes blank and every description collapses onto the fallback
      // (the duplicate-listings audit critical). The typed-span/:not(meta) guard
      // must skip the void node and still read the real body content.
      const withHeadMeta = detailHtml('Pflegefachperson HF', 'Pflege leisten', 'Diplom Pflege')
        .replace(
          '<html><body>',
          '<html><head>' +
            '<meta itemprop="title" content="">' +
            '<meta itemprop="description" content="">' +
            '</head><body>',
        );
      const d = parseDetailPage(withHeadMeta);
      expect(d?.title).toBe('Pflegefachperson HF');
      expect(d?.description).toContain('Pflege leisten');
      expect(d?.description).toContain('Diplom Pflege');
    });
  });

  describe('descriptionBodyToMarkdown', () => {
    it('recurses through nested style <div>s so lists/headings survive (axpo flat converter would collapse them)', () => {
      const body = '<div><div><h2><b>AUFGABEN</b></h2></div><div><ul><li>Eins</li><li>Zwei</li></ul></div></div>';
      const md = descriptionBodyToMarkdown(body);
      expect(md).toMatch(/^## AUFGABEN$/m);
      expect(md).toMatch(/^- Eins$/m);
      expect(md).toMatch(/^- Zwei$/m);
    });

    it('returns empty string for empty input', () => {
      expect(descriptionBodyToMarkdown('')).toBe('');
      expect(descriptionBodyToMarkdown('   ')).toBe('');
    });
  });
});
