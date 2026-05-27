import { describe, it, expect } from 'vitest';
import {
  HEINEKEN_CH_KEY,
  HEINEKEN_CH_COMPANY_NAME,
  isHeinekenChJob,
  isTrustedDomain,
  parseSearchResults,
  parseDetailPage,
  parseDate,
  parseLocation,
  detectCategory,
  detectEmploymentType,
  extractTotalResults,
  buildFallbackDescription,
} from '../scripts/lib/heineken-ch-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Heineken Switzerland crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(HEINEKEN_CH_KEY).toBe('heineken-ch');
    expect(HEINEKEN_CH_COMPANY_NAME).toBe('Heineken Switzerland');
  });

  // ── isHeinekenChJob ──
  describe('isHeinekenChJob', () => {
    it('matches by companyKey', () => {
      expect(isHeinekenChJob({ companyKey: 'heineken-ch' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isHeinekenChJob({ company: 'Heineken Switzerland' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isHeinekenChJob({ url: 'https://theheinekencompany.com/jobs/123' })).toBe(true);
    });

    it('matches by Calanda company name', () => {
      expect(isHeinekenChJob({ company: 'Calanda Brauerei' })).toBe(true);
    });

    it('matches careers subdomain URL', () => {
      expect(isHeinekenChJob({ url: 'https://careers.theheinekencompany.com/Switzerland/job/Chur/123/' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isHeinekenChJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isHeinekenChJob(null)).toBe(false);
      expect(isHeinekenChJob(undefined)).toBe(false);
      expect(isHeinekenChJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://theheinekencompany.com/careers/job-123')).toBe(true);
    });

    it('trusts careers subdomain', () => {
      expect(isTrustedDomain('https://careers.theheinekencompany.com/job/456')).toBe(true);
    });

    it('trusts SuccessFactors domain', () => {
      expect(isTrustedDomain('https://career5.successfactors.eu/career?company=heineken')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── parseDate ──
  describe('parseDate', () => {
    it('parses DD.MM.YYYY format', () => {
      expect(parseDate('09.04.2026')).toBe('2026-04-09');
    });

    it('parses single-digit day and month', () => {
      expect(parseDate('1.3.2025')).toBe('2025-03-01');
    });

    it('returns empty string for invalid input', () => {
      expect(parseDate('')).toBe('');
      expect(parseDate('invalid')).toBe('');
      expect(parseDate(undefined)).toBe('');
    });
  });

  // ── parseLocation ──
  describe('parseLocation', () => {
    it('parses "City, CH, PostalCode" format', () => {
      const result = parseLocation('Chur, CH, 7000');
      expect(result.city).toBe('Chur');
      expect(result.postalCode).toBe('7000');
    });

    it('parses "City, CH" without postal code', () => {
      const result = parseLocation('Luzern, CH');
      expect(result.city).toBe('Luzern');
    });

    it('handles city-only input', () => {
      const result = parseLocation('Fahrweid');
      expect(result.city).toBe('Fahrweid');
    });

    it('returns HQ defaults for empty input', () => {
      const result = parseLocation('');
      expect(result.city).toBe('Chur');
    });
  });

  // ── parseSearchResults ──
  describe('parseSearchResults', () => {
    const sampleSearchHtml = `
      <table>
        <tr>
          <td><a href="/Switzerland/job/Chur-Brauer-Chur-7000/1283406601/">Brauer/Lebensmitteltechnologe Chur (m/w)</a></td>
          <td>Supply Chain</td>
          <td>Chur, CH, 7000</td>
          <td>01.04.2026</td>
        </tr>
        <tr>
          <td><a href="/Switzerland/job/Chur-Elektroinstallateur-7000/1277563801/">Elektroinstallateur/Automatiker Chur (m/w)</a></td>
          <td>Supply Chain</td>
          <td>Chur, CH, 7000</td>
          <td>29.03.2026</td>
        </tr>
        <tr>
          <td>Header Row Without Link</td>
          <td>Department</td>
          <td>Location</td>
          <td>Date</td>
        </tr>
      </table>
    `;

    it('extracts jobs from search results HTML', () => {
      const jobs = parseSearchResults(sampleSearchHtml);
      expect(jobs).toHaveLength(2);
    });

    it('extracts correct job fields', () => {
      const jobs = parseSearchResults(sampleSearchHtml);
      const brewer = jobs[0];
      expect(brewer.title).toBe('Brauer/Lebensmitteltechnologe Chur (m/w)');
      expect(brewer.url).toBe('https://careers.theheinekencompany.com/Switzerland/job/Chur-Brauer-Chur-7000/1283406601/');
      expect(brewer.department).toBe('Supply Chain');
      expect(brewer.location).toBe('Chur, CH, 7000');
      expect(brewer.jobId).toBe('1283406601');
      expect(brewer.postedDate).toBe('2026-04-01');
    });

    it('skips rows without job links', () => {
      const jobs = parseSearchResults(sampleSearchHtml);
      // The header row should not be included
      expect(jobs.every((j) => j.title !== 'Header Row Without Link')).toBe(true);
    });

    it('deduplicates by job ID', () => {
      const dupeHtml = `
        <table>
          <tr>
            <td><a href="/Switzerland/job/Chur-Brauer-7000/1283406601/">Brauer (m/w)</a></td>
            <td>Supply Chain</td><td>Chur</td><td>01.04.2026</td>
          </tr>
          <tr>
            <td><a href="/Switzerland/job/Chur-Brauer-7000/1283406601/">Brauer (m/w) Dup</a></td>
            <td>Supply Chain</td><td>Chur</td><td>01.04.2026</td>
          </tr>
        </table>
      `;
      const jobs = parseSearchResults(dupeHtml);
      expect(jobs).toHaveLength(1);
    });

    it('returns empty array for invalid input', () => {
      expect(parseSearchResults('')).toEqual([]);
      expect(parseSearchResults(null)).toEqual([]);
      expect(parseSearchResults(undefined)).toEqual([]);
    });
  });

  // ── extractTotalResults ──
  describe('extractTotalResults', () => {
    it('extracts German format', () => {
      expect(extractTotalResults('Ergebnisse 1 – 14 von 14')).toBe(14);
    });

    it('extracts English format', () => {
      expect(extractTotalResults('Results 1 – 10 of 25')).toBe(25);
    });

    it('returns 0 for no match', () => {
      expect(extractTotalResults('')).toBe(0);
      expect(extractTotalResults('no results')).toBe(0);
    });
  });

  // ── parseDetailPage ──
  describe('parseDetailPage', () => {
    const sampleDetailHtml = `
      <html>
        <body>
          <h2>Anlagenführer:in befristet in Chur</h2>
          <div>Ort: Chur</div>
          <div id="content">
            <p>HEINEKEN sucht eine erfahrene und flexible Person für die Abfüllung.
            Sie arbeiten in einem 3-Schicht-Betrieb und sind verantwortlich für die
            Bedienung der Abfüllanlagen. Diese Position bietet Ihnen die Möglichkeit,
            in einem dynamischen Umfeld zu arbeiten und Ihre technischen Fähigkeiten
            einzusetzen. Wir suchen teamfähige Personen mit einer Ausbildung als
            Anlagenführer oder vergleichbar, Erfahrung in der Lebensmittelindustrie,
            technisches Verständnis und Hygienebewusstsein. Fliessende Deutschkenntnisse
            in Wort und Schrift werden vorausgesetzt.</p>
          </div>
          <a href="/talentcommunity/apply/1382085733/?locale=de_DE">Jetzt bewerben</a>
        </body>
      </html>
    `;

    it('extracts title from h2', () => {
      const result = parseDetailPage(sampleDetailHtml);
      expect(result).not.toBeNull();
      expect(result.title).toBe('Anlagenführer:in befristet in Chur');
    });

    it('extracts description', () => {
      const result = parseDetailPage(sampleDetailHtml);
      expect(result.description).toContain('HEINEKEN');
      expect(result.description.length).toBeGreaterThan(50);
    });

    it('extracts apply URL', () => {
      const result = parseDetailPage(sampleDetailHtml);
      expect(result.applyUrl).toContain('/talentcommunity/apply/1382085733/');
    });

    it('extracts location', () => {
      const result = parseDetailPage(sampleDetailHtml);
      expect(result.location).toBe('Chur');
    });

    it('returns null for invalid input', () => {
      expect(parseDetailPage('')).toBeNull();
      expect(parseDetailPage(null)).toBeNull();
      expect(parseDetailPage(undefined)).toBeNull();
    });
  });

  // ── detectCategory ──
  describe('detectCategory', () => {
    it('detects production roles', () => {
      expect(detectCategory('Brauer/Lebensmitteltechnologe', 'Supply Chain')).toBe('Produzione');
      expect(detectCategory('Anlagenführer:in', 'Production')).toBe('Produzione');
    });

    it('detects technical roles', () => {
      expect(detectCategory('Elektroinstallateur/Automatiker', '')).toBe('Tecnica');
    });

    it('detects logistics roles', () => {
      expect(detectCategory('Truck Driver', 'Supply Chain')).toBe('Logistica');
      expect(detectCategory('Chauffeur C/E', '')).toBe('Logistica');
      expect(detectCategory('Logistiker/in Getränkelager', '')).toBe('Logistica');
    });

    it('detects sales roles', () => {
      expect(detectCategory('Category Manager/in Weine', 'Verkauf')).toBe('Commerciale');
      expect(detectCategory('Conseiller de vente', 'Commerce')).toBe('Commerciale');
    });

    it('detects brewery tours as production', () => {
      expect(detectCategory('Mitarbeiter Brauereiführungen', '')).toBe('Produzione');
    });

    it('defaults to Altro for unknown titles', () => {
      expect(detectCategory('Praktikant Nachhaltigkeit', '')).toBe('Altro');
    });
  });

  // ── detectEmploymentType ──
  describe('detectEmploymentType', () => {
    it('detects full-time', () => {
      expect(detectEmploymentType('Vollzeit 100%')).toBe('FULL_TIME');
    });

    it('detects part-time from percentage', () => {
      expect(detectEmploymentType('60%-80% Pensum')).toBe('PART_TIME');
    });

    it('detects part-time from keyword', () => {
      expect(detectEmploymentType('Teilzeit Position')).toBe('PART_TIME');
    });

    it('detects part-time from low percentage', () => {
      expect(detectEmploymentType('10% auf Abruf')).toBe('PART_TIME');
    });

    it('defaults to FULL_TIME', () => {
      expect(detectEmploymentType('Brauer Chur')).toBe('FULL_TIME');
    });
  });

  // ── buildFallbackDescription ──
  describe('buildFallbackDescription', () => {
    it('generates description with >50 words', () => {
      const desc = buildFallbackDescription('Brauer', 'Chur', 'Supply Chain');
      const wordCount = desc.split(/\s+/).length;
      expect(wordCount).toBeGreaterThan(50);
    });

    it('includes company and location info', () => {
      const desc = buildFallbackDescription('Brauer', 'Chur', 'Supply Chain');
      expect(desc).toContain('Heineken Switzerland');
      expect(desc).toContain('Calanda');
      expect(desc).toContain('Chur');
    });

    it('includes department when provided', () => {
      const desc = buildFallbackDescription('Brauer', 'Chur', 'Supply Chain');
      expect(desc).toContain('Supply Chain');
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
      expect(slugify('Anlagenführer:in')).toMatch(/^anlagenfu/);
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer heineken-ch ch')).toBe('developer-heineken-ch-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'heineken-ch-abc123def456',
      slug: 'brauer-lebensmitteltechnologe-heineken-ch-chur',
      slugByLocale: { de: 'brauer-lebensmitteltechnologe-heineken-ch-chur' },
      company: 'Heineken Switzerland',
      companyKey: 'heineken-ch',
      companyDomain: 'theheinekencompany.com',
      title: 'Brauer/Lebensmitteltechnologe Chur (m/w)',
      titleByLocale: { de: 'Brauer/Lebensmitteltechnologe Chur (m/w)' },
      description: 'A test job description for validation with enough words to pass the minimum threshold for content quality checks.',
      descriptionByLocale: { de: 'A test job description for validation with enough words to pass the minimum threshold for content quality checks.' },
      location: 'Chur',
      canton: 'GR',
      addressLocality: 'Chur',
      addressRegion: 'GR',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '7000',
      streetAddress: 'Chur, Graubünden',
      url: 'https://careers.theheinekencompany.com/Switzerland/job/Chur-Brauer-7000/1283406601/',
      applyUrl: 'https://careers.theheinekencompany.com/talentcommunity/apply/1283406601/?locale=de_DE',
      source: 'Heineken Switzerland Dedicated Parser (SuccessFactors)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      category: 'Produzione',
      sector: 'Industria / Alimentare',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: 'mid',
      featured: false,
      postedDate: '2026-04-01',
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

    it('has all SEO-required fields', () => {
      const seoFields = [
        'addressLocality', 'addressRegion', 'addressCountry',
        'postalCode', 'streetAddress', 'employmentType',
        'sector', 'postedDate',
      ];
      for (const field of seoFields) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field]).toBeTruthy();
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^heineken-ch-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('canton is GR for Chur', () => {
      expect(validJob.canton).toBe('GR');
    });

    it('sector is food/beverage industry', () => {
      expect(validJob.sector).toBe('Industria / Alimentare');
    });
  });
});
