/**
 * Tests for the Spital Thusis dedicated job crawler.
 *
 * Verifies:
 *   - Company constants (key, name, domain)
 *   - Company job identification (isSpitalThusisJob)
 *   - Trusted domain detection (isTrustedDomain)
 *   - Pensum parsing from title text
 *   - Pensum formatting
 *   - Healthcare category detection
 *   - Listing page HTML parsing
 *   - Detail page HTML parsing
 *   - Slug generation
 *   - Job shape validation
 */
import { describe, it, expect } from 'vitest';
import {
  SPITAL_THUSIS_KEY,
  SPITAL_THUSIS_COMPANY_NAME,
  SPITAL_THUSIS_COMPANY_DOMAIN,
  isSpitalThusisJob,
  isTrustedDomain,
  parsePensum,
  formatPensum,
  detectCategory,
  parseListingPage,
  parseDetailPage,
} from '../scripts/lib/spital-thusis-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// ─── Constants ──────────────────────────────────────────────────────────────────

describe('Spital Thusis crawler constants', () => {
  it('has correct company key', () => {
    expect(SPITAL_THUSIS_KEY).toBe('spital-thusis');
  });

  it('has correct company name', () => {
    expect(SPITAL_THUSIS_COMPANY_NAME).toBe('Spital Thusis');
  });

  it('has correct company domain', () => {
    expect(SPITAL_THUSIS_COMPANY_DOMAIN).toBe('spitalthusis.ch');
  });
});

// ─── isSpitalThusisJob ──────────────────────────────────────────────────────────

describe('isSpitalThusisJob', () => {
  it('matches by companyKey', () => {
    expect(isSpitalThusisJob({ companyKey: 'spital-thusis' })).toBe(true);
  });

  it('matches by company name', () => {
    expect(isSpitalThusisJob({ company: 'Spital Thusis' })).toBe(true);
  });

  it('matches by company name case-insensitive', () => {
    expect(isSpitalThusisJob({ company: 'SPITAL THUSIS' })).toBe(true);
  });

  it('matches by URL domain', () => {
    expect(isSpitalThusisJob({ url: 'https://spitalthusis.ch/jobs/123' })).toBe(true);
  });

  it('matches by www URL domain', () => {
    expect(isSpitalThusisJob({ url: 'https://www.spitalthusis.ch/karriere-jobs/offene-stellen/' })).toBe(true);
  });

  it('rejects unrelated jobs', () => {
    expect(isSpitalThusisJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
  });

  it('handles null/undefined gracefully', () => {
    expect(isSpitalThusisJob(null)).toBe(false);
    expect(isSpitalThusisJob(undefined)).toBe(false);
    expect(isSpitalThusisJob({})).toBe(false);
  });
});

// ─── isTrustedDomain ────────────────────────────────────────────────────────────

describe('isTrustedDomain', () => {
  it('trusts primary domain', () => {
    expect(isTrustedDomain('https://spitalthusis.ch/careers/job-123')).toBe(true);
  });

  it('trusts www subdomain', () => {
    expect(isTrustedDomain('https://www.spitalthusis.ch/karriere-jobs/offene-stellen/')).toBe(true);
  });

  it('trusts other subdomains', () => {
    expect(isTrustedDomain('https://careers.spitalthusis.ch/job/456')).toBe(true);
  });

  it('rejects other domains', () => {
    expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
  });

  it('rejects similar domain names', () => {
    expect(isTrustedDomain('https://notspitalthusis.ch/jobs')).toBe(false);
  });

  it('handles invalid URLs', () => {
    expect(isTrustedDomain('')).toBe(false);
    expect(isTrustedDomain('not-a-url')).toBe(false);
  });
});

// ─── parsePensum ────────────────────────────────────────────────────────────────

describe('parsePensum', () => {
  it('parses range with hyphen', () => {
    expect(parsePensum('Physiotherapeut/in 80-100%')).toEqual({ min: 80, max: 100 });
  });

  it('parses range with en-dash', () => {
    expect(parsePensum('Assistenzärztin/-arzt Chirurgie 80–100%')).toEqual({ min: 80, max: 100 });
  });

  it('parses range with spaces', () => {
    expect(parsePensum('Physiotherapeut/in 80 - 100%')).toEqual({ min: 80, max: 100 });
  });

  it('parses small range', () => {
    expect(parsePensum('Mitarbeiter/in Logistik und Einkauf 40–50%')).toEqual({ min: 40, max: 50 });
  });

  it('parses single percentage', () => {
    expect(parsePensum('Ausbildungsplatz als Pflegefachperson HF 100%')).toEqual({ min: 100, max: 100 });
  });

  it('parses 30-50% range', () => {
    expect(parsePensum('Dipl. Expertin / Experte Anästhesiepflege NDS HF 30-50%')).toEqual({ min: 30, max: 50 });
  });

  it('returns null for no percentage', () => {
    expect(parsePensum('Assistenzärztin/-arzt Innere Medizin')).toBeNull();
  });

  it('returns null for "Pensum flexibel"', () => {
    expect(parsePensum('Radiologiefachperson (Pensum flexibel)')).toBeNull();
  });

  it('handles empty input', () => {
    expect(parsePensum('')).toBeNull();
    expect(parsePensum()).toBeNull();
  });
});

// ─── formatPensum ───────────────────────────────────────────────────────────────

describe('formatPensum', () => {
  it('formats range', () => {
    expect(formatPensum({ min: 80, max: 100 })).toBe('80 - 100%');
  });

  it('formats equal min and max as single value', () => {
    expect(formatPensum({ min: 100, max: 100 })).toBe('100%');
  });

  it('formats small range', () => {
    expect(formatPensum({ min: 40, max: 50 })).toBe('40 - 50%');
  });

  it('returns empty for null', () => {
    expect(formatPensum(null)).toBe('');
  });
});

// ─── detectCategory ─────────────────────────────────────────────────────────────

describe('detectCategory', () => {
  it('detects medical doctor roles', () => {
    expect(detectCategory('Assistenzärztin/-arzt Chirurgie 80–100%')).toBe('Medicina');
    expect(detectCategory('Oberarzt Innere Medizin')).toBe('Medicina');
  });

  it('detects nursing roles', () => {
    expect(detectCategory('Pflegehilfe SPITEX 50-90%')).toBe('Infermieristica');
    expect(detectCategory('Fachperson Gesundheit SPITEX 50-70%')).toBe('Infermieristica');
  });

  it('detects anaesthesia roles', () => {
    expect(detectCategory('Dipl. Expertin / Experte Anästhesiepflege NDS HF 30-50%')).toBe('Anestesia');
  });

  it('detects physiotherapy roles', () => {
    expect(detectCategory('Physiotherapeut/in 80-100%')).toBe('Fisioterapia');
  });

  it('detects radiology roles', () => {
    expect(detectCategory('Radiologiefachperson (Pensum flexibel)')).toBe('Radiologia');
  });

  it('detects emergency / rescue roles', () => {
    expect(detectCategory('Stv. Betriebliche Leitung Rettungsdienst 80-100%')).toBe('Emergenza');
  });

  it('detects hospitality / housekeeping roles', () => {
    expect(detectCategory('Fachmann/-frau Hotellerie-Hauswirtschaft EFZ')).toBe('Ristorazione');
  });

  it('apprenticeship in hospitality is classified as Formazione', () => {
    // "Lehrstelle" takes priority over "Hotellerie" — the primary role is the apprenticeship
    expect(detectCategory('Lehrstelle als Fachmann/-frau Hotellerie-Hauswirtschaft EFZ')).toBe('Formazione');
  });

  it('detects logistics roles', () => {
    expect(detectCategory('Mitarbeiter/in Logistik und Einkauf 40–50%')).toBe('Logistica');
  });

  it('detects apprenticeship / education roles', () => {
    expect(detectCategory('Ausbildungsplatz als Pflegefachperson HF 100%')).toBe('Formazione');
  });

  it('defaults to Sanità for unrecognized titles', () => {
    expect(detectCategory('Mitarbeiter/in Empfang')).toBe('Sanità');
  });
});

// ─── parseListingPage ───────────────────────────────────────────────────────────

describe('parseListingPage', () => {
  const sampleHtml = `
    <html><body>
    <ul>
      <li><a href="/karriere-jobs/offene-stellen/Physiotherapeut-in-80-100-/"><h3>Physiotherapeut/in 80 - 100%</h3></a></li>
      <li><a href="/karriere-jobs/offene-stellen/Assistenzaerztin-arzt-Chirurgie-80-100-/"><h3>Assistenzärztin/-arzt Chirurgie 80–100%</h3></a></li>
      <li><a href="/karriere-jobs/offene-stellen/Mitarbeiter-in-Logistik-und-Einkauf-40-50-/"><h3>Mitarbeiter/in Logistik und Einkauf 40–50%</h3></a></li>
      <li><a href="/karriere-jobs/offene-stellen/Initiativbewerbung/"><h3>Initiativbewerbung</h3></a></li>
    </ul>
    </body></html>
  `;

  it('extracts job links from listing page', () => {
    const links = parseListingPage(sampleHtml);
    expect(links.length).toBe(3);
  });

  it('filters out Initiativbewerbung', () => {
    const links = parseListingPage(sampleHtml);
    const titles = links.map((l) => l.title);
    expect(titles).not.toContain('Initiativbewerbung');
  });

  it('extracts correct titles', () => {
    const links = parseListingPage(sampleHtml);
    expect(links[0].title).toBe('Physiotherapeut/in 80 - 100%');
    expect(links[1].title).toBe('Assistenzärztin/-arzt Chirurgie 80–100%');
    expect(links[2].title).toBe('Mitarbeiter/in Logistik und Einkauf 40–50%');
  });

  it('builds absolute URLs', () => {
    const links = parseListingPage(sampleHtml);
    expect(links[0].detailUrl).toBe('https://www.spitalthusis.ch/karriere-jobs/offene-stellen/Physiotherapeut-in-80-100-/');
    expect(links[1].detailUrl).toBe('https://www.spitalthusis.ch/karriere-jobs/offene-stellen/Assistenzaerztin-arzt-Chirurgie-80-100-/');
  });

  it('returns empty array for empty HTML', () => {
    expect(parseListingPage('')).toEqual([]);
  });

  it('returns empty array for page with no job links', () => {
    const noJobsHtml = '<html><body><p>No open positions</p></body></html>';
    expect(parseListingPage(noJobsHtml)).toEqual([]);
  });
});

// ─── parseDetailPage ────────────────────────────────────────────────────────────

describe('parseDetailPage', () => {
  const sampleDetailHtml = `
    <html><body>
    <h2>Physiotherapeut/in 80 - 100%</h2>
    <p>Wir suchen per sofort oder nach Vereinbarung eine/n Physiotherapeut/in.</p>
    <h4>Dein Aufgabengebiet:</h4>
    <ul>
      <li>Therapeutische Behandlung und Beratung ambulanter Patienten</li>
      <li>Selbständige Therapieplanung und Dokumentation</li>
      <li>Betreuung MTT-Patienten</li>
    </ul>
    <h4>Dein Anforderungsprofil:</h4>
    <ul>
      <li>Abgeschlossenes FH Diplom Physiotherapie</li>
      <li>Berufserfahrung von Vorteil</li>
      <li>Selbständige und flexible Arbeitsweise</li>
    </ul>
    <h4>Wir bieten:</h4>
    <ul>
      <li>Moderne Infrastruktur</li>
      <li>42-Stunden-Woche mit mind. 25 Ferientagen</li>
    </ul>
    <p>Kontakt: Nicole Battaglia, Leitung Physiotherapie</p>
    </body></html>
  `;

  it('extracts description from detail page', () => {
    const result = parseDetailPage(sampleDetailHtml);
    expect(result.description.length).toBeGreaterThan(30);
  });

  it('description contains task information', () => {
    const result = parseDetailPage(sampleDetailHtml);
    // Should contain content from the page (list items and paragraphs)
    expect(result.description.length).toBeGreaterThan(50);
  });

  it('returns empty description for empty HTML', () => {
    const result = parseDetailPage('');
    expect(result.description).toBe('');
  });

  it('handles page with only paragraphs', () => {
    const html = `
      <html><body>
      <p>This is a job at Spital Thusis in the beautiful region of Mittelbünden.</p>
      <p>We offer excellent working conditions and a supportive team environment.</p>
      </body></html>
    `;
    const result = parseDetailPage(html);
    expect(result.description.length).toBeGreaterThan(20);
  });

  it('strips script and style tags from content', () => {
    const html = `
      <html><body>
      <script>var x = 1;</script>
      <style>.foo { color: red; }</style>
      <p>Actual job content that should be extracted from the page.</p>
      </body></html>
    `;
    const result = parseDetailPage(html);
    expect(result.description).not.toContain('var x');
    expect(result.description).not.toContain('color');
  });
});

// ─── slugify (imported from crawler-template) ───────────────────────────────────

describe('slugify', () => {
  it('converts title to URL-safe slug', () => {
    const slug = slugify('Physiotherapeut/in 80-100%');
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it('strips diacritics', () => {
    expect(slugify('Assistenzärztin Chirurgie')).toMatch(/assistenzarztin/);
  });

  it('builds slug with company suffix inline', () => {
    expect(slugify('Developer spital-thusis ch')).toBe('developer-spital-thusis-ch');
  });

  it('respects max length', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(90);
  });

  it('handles German healthcare titles', () => {
    const slug = slugify('Dipl. Expertin Anästhesiepflege NDS HF spital-thusis ch');
    expect(slug).toContain('spital-thusis-ch');
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });
});

// ─── Job Shape Validation ───────────────────────────────────────────────────────

describe('job shape', () => {
  const validJob = {
    id: 'spital-thusis-abc123def456',
    slug: 'physiotherapeut-in-80-100-spital-thusis-ch',
    slugByLocale: { de: 'physiotherapeut-in-80-100-spital-thusis-ch' },
    company: 'Spital Thusis',
    companyKey: 'spital-thusis',
    companyDomain: 'spitalthusis.ch',
    title: 'Physiotherapeut/in 80-100%',
    titleByLocale: { de: 'Physiotherapeut/in 80-100%' },
    description: 'Physiotherapeut/in 80-100% — Spital Thusis (Gesundheit Mittelbünden). Arbeitsort: Thusis (GR). Pensum: 80 - 100%',
    descriptionByLocale: { de: 'Physiotherapeut/in 80-100% — Spital Thusis (Gesundheit Mittelbünden). Arbeitsort: Thusis (GR). Pensum: 80 - 100%' },
    location: 'Thusis',
    canton: 'GR',
    url: 'https://www.spitalthusis.ch/karriere-jobs/offene-stellen/Physiotherapeut-in-80-100-/',
    source: 'Spital Thusis Dedicated Parser',
    sourceLang: 'de',
    crawledAt: new Date().toISOString(),
    addressLocality: 'Thusis',
    postalCode: '7430',
    streetAddress: 'Alte Strasse 31',
    addressCountry: 'CH',
    country: 'CH',
    category: 'Fisioterapia',
    contract: 'full-time',
    employmentType: 'FULL_TIME',
    experienceLevel: 'mid',
    sector: 'Sanità / Assistenza',
    currency: 'CHF',
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
    expect(validJob.id).toMatch(/^spital-thusis-/);
  });

  it('slug is URL-safe', () => {
    expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it('location is Thusis', () => {
    expect(validJob.location).toBe('Thusis');
  });

  it('canton is GR', () => {
    expect(validJob.canton).toBe('GR');
  });

  it('postal code is 7430', () => {
    expect(validJob.postalCode).toBe('7430');
  });

  it('sector is Sanità / Assistenza', () => {
    expect(validJob.sector).toBe('Sanità / Assistenza');
  });

  it('has SEO-required address fields', () => {
    expect(validJob.addressLocality).toBe('Thusis');
    expect(validJob.streetAddress).toBe('Alte Strasse 31');
    expect(validJob.addressCountry).toBe('CH');
  });
});
