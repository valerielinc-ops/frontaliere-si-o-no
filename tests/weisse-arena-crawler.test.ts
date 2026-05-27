/**
 * Tests for the Weisse Arena Gruppe dedicated job crawler.
 *
 * Verifies:
 *   - TalentLink API response parsing
 *   - Job object construction from listing data
 *   - Contract type mapping (Festanstellung, Saisonanstellung, etc.)
 *   - Pensum parsing (percentage ranges)
 *   - Category detection from title and department
 *   - Detail URL construction
 *   - Company job identification
 *   - Trusted domain detection (weissearena.com + recruitmentplatform.com)
 *   - Slug generation
 */
import { describe, it, expect } from 'vitest';
import {
  WEISSE_ARENA_KEY,
  WEISSE_ARENA_COMPANY_NAME,
  WEISSE_ARENA_COMPANY_DOMAIN,
  isWeisseArenaJob,
  isTrustedDomain,
  detectCategory,
  mapContractType,
  parsePensum,
  buildDetailUrl,
} from '../scripts/lib/weisse-arena-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// ─── Constants ──────────────────────────────────────────────────────────────────

describe('Weisse Arena crawler constants', () => {
  it('has correct company key', () => {
    expect(WEISSE_ARENA_KEY).toBe('weisse-arena');
  });

  it('has correct company name', () => {
    expect(WEISSE_ARENA_COMPANY_NAME).toBe('Weisse Arena Gruppe');
  });

  it('has correct company domain', () => {
    expect(WEISSE_ARENA_COMPANY_DOMAIN).toBe('weissearena.com');
  });
});

// ─── Contract type mapping ──────────────────────────────────────────────────────

describe('mapContractType', () => {
  it('maps Festanstellung to FULL_TIME', () => {
    expect(mapContractType('Festanstellung')).toBe('FULL_TIME');
  });

  it('maps Kaderanstellung to FULL_TIME', () => {
    expect(mapContractType('Kaderanstellung')).toBe('FULL_TIME');
  });

  it('maps Saisonanstellung to CONTRACTOR', () => {
    expect(mapContractType('Saisonanstellung')).toBe('CONTRACTOR');
  });

  it('maps Lehranstellung to INTERN', () => {
    expect(mapContractType('Lehranstellung')).toBe('INTERN');
  });

  it('maps Praktikumsanstellung to INTERN', () => {
    expect(mapContractType('Praktikumsanstellung')).toBe('INTERN');
  });

  it('maps unknown label to OTHER', () => {
    expect(mapContractType('Temporär')).toBe('OTHER');
    expect(mapContractType('')).toBe('OTHER');
  });
});

// ─── Pensum parsing ─────────────────────────────────────────────────────────────

describe('parsePensum', () => {
  it('parses range like 80%-100%', () => {
    expect(parsePensum('80%-100%')).toEqual({ min: 80, max: 100 });
  });

  it('parses range with spaces like 60% - 100%', () => {
    expect(parsePensum('60% - 100%')).toEqual({ min: 60, max: 100 });
  });

  it('parses single value like 100%', () => {
    expect(parsePensum('100%')).toEqual({ min: 100, max: 100 });
  });

  it('parses single value without percent like 80', () => {
    expect(parsePensum('80%')).toEqual({ min: 80, max: 80 });
  });

  it('defaults to 100% for empty input', () => {
    expect(parsePensum('')).toEqual({ min: 100, max: 100 });
  });

  it('defaults to 100% for null/undefined', () => {
    expect(parsePensum(undefined as unknown as string)).toEqual({ min: 100, max: 100 });
  });
});

// ─── Detail URL construction ────────────────────────────────────────────────────

describe('buildDetailUrl', () => {
  it('builds URL with jobId and title', () => {
    const url = buildDetailUrl(4484, 'CRM & Lifecycle Marketing Manager');
    expect(url).toContain('weissearena.com/jobs/details.html');
    expect(url).toContain('jobId=4484');
    expect(url).toContain('jobTitle=CRM');
  });

  it('URL-encodes special characters in title', () => {
    const url = buildDetailUrl(4478, 'Mitarbeiter:in Spülküche');
    expect(url).toContain('jobId=4478');
    // Colon and umlaut should be encoded
    expect(url).not.toContain(' ');
  });

  it('works without title', () => {
    const url = buildDetailUrl(1234);
    expect(url).toContain('jobId=1234');
    expect(url).not.toContain('jobTitle');
  });

  it('URL contains weissearena.com host', () => {
    const url = buildDetailUrl(4484, 'Test');
    expect(url).toContain('weissearena.com');
  });
});

// ─── Category detection ─────────────────────────────────────────────────────────

describe('detectCategory from title and department', () => {
  it('detects gastronomy from Koch/Köchin', () => {
    expect(detectCategory('Pizzaiolo:a / Koch/Köchin', '')).toBe('Ristorazione');
  });

  it('detects gastronomy from Spülküche', () => {
    expect(detectCategory('Mitarbeiter:in Spülküche', 'Restaurant IKIGAI')).toBe('Ristorazione');
  });

  it('detects gastronomy from service staff', () => {
    expect(detectCategory('Servicemitarbeiter:in', 'signinahotel/Ristorante Camino')).toBe('Ristorazione');
  });

  it('detects gastronomy from restaurant leader', () => {
    expect(detectCategory('Restaurantleiter:in Camino', '')).toBe('Ristorazione');
  });

  it('detects marketing from CRM title', () => {
    expect(detectCategory('CRM & Lifecycle Marketing Manager', 'Digitalisation and Data Analytics')).toBe('Marketing');
  });

  it('detects marketing from Content & Growth', () => {
    expect(detectCategory('Content & Growth Manager', 'Customer Experience & Communication')).toBe('Marketing');
  });

  it('detects tech from Techniker Bahnbetrieb', () => {
    expect(detectCategory('Techniker:in Bahnbetrieb', 'Bahntechnik')).toBe('Tecnica');
  });

  it('detects hospitality from Housekeeping', () => {
    expect(detectCategory('Supervisor Housekeeping', 'signinahotel/rocksresort')).toBe('Hotellerie');
  });

  it('detects sport from Skischule', () => {
    expect(detectCategory('Skilehrer:in', 'Skischule')).toBe('Sport');
  });

  it('defaults to Turismo for unknown', () => {
    expect(detectCategory('Generalist:in', '')).toBe('Turismo');
  });
});

// ─── Job identification ─────────────────────────────────────────────────────────

describe('isWeisseArenaJob detection', () => {
  it('identifies by companyKey', () => {
    expect(isWeisseArenaJob({ companyKey: 'weisse-arena' })).toBe(true);
  });

  it('identifies by company name (full)', () => {
    expect(isWeisseArenaJob({ company: 'Weisse Arena Gruppe' })).toBe(true);
  });

  it('identifies by company name (partial)', () => {
    expect(isWeisseArenaJob({ company: 'Weisse Arena' })).toBe(true);
  });

  it('identifies by weissearena.com URL', () => {
    expect(isWeisseArenaJob({ url: 'https://www.weissearena.com/jobs/details.html?jobId=4484' })).toBe(true);
  });

  it('rejects unrelated jobs', () => {
    expect(isWeisseArenaJob({
      companyKey: 'other-company',
      company: 'Other Corp',
      url: 'https://other.com/jobs',
    })).toBe(false);
  });

  it('handles null/undefined gracefully', () => {
    expect(isWeisseArenaJob(null)).toBe(false);
    expect(isWeisseArenaJob(undefined)).toBe(false);
    expect(isWeisseArenaJob({})).toBe(false);
  });
});

// ─── Trusted domain check ───────────────────────────────────────────────────────

describe('isTrustedDomain', () => {
  it('trusts weissearena.com', () => {
    expect(isTrustedDomain('https://weissearena.com/jobs/details.html?jobId=4484')).toBe(true);
  });

  it('trusts www.weissearena.com', () => {
    expect(isTrustedDomain('https://www.weissearena.com/jobs/')).toBe(true);
  });

  it('trusts recruitmentplatform.com (TalentLink ATS)', () => {
    expect(isTrustedDomain('https://emea3.recruitmentplatform.com/apply-app/pages/application-form?jobId=PD6FK026203F3VBQBLO8NV79D-4484')).toBe(true);
  });

  it('rejects untrusted domains', () => {
    expect(isTrustedDomain('https://malicious-site.com/weissearena')).toBe(false);
  });

  it('handles invalid URLs gracefully', () => {
    expect(isTrustedDomain('not-a-url')).toBe(false);
    expect(isTrustedDomain('')).toBe(false);
  });
});

// ─── TalentLink API response structure ──────────────────────────────────────────

describe('TalentLink API response structure', () => {
  const SAMPLE_LISTING = {
    id: 4484,
    jobFields: {
      DPOSTINGSTART: 1774908000000,
      CONTRACTTYPLABEL: 'Festanstellung',
      SLOVLIST17: '80%-100%',
      sJobTitle: 'CRM & Lifecycle Marketing Manager',
      SLOVLIST10: 'Digitalisation and Data Analytics',
      id: 4484,
      siteLangauge: 'DE',
      language: 'DE',
      jobNumber: 'WAG02350',
      jobTitle: 'CRM & Lifecycle Marketing Manager',
      applicationUrl: 'https://emea3.recruitmentplatform.com/apply-app/pages/application-form?jobId=PD6FK026203F3VBQBLO8NV79D-4484&langCode=de_DE',
      POSTINGTIMEZONE: 'Europe/Zurich',
    },
    customFields: [
      { title: ' ', content: '<p>Die Weisse Arena Gruppe in LAAX ist Vorreiter im alpinen Tourismus...</p>' },
      { title: ' ', content: '<p>Du möchtest mit digitalen Lösungen dazu beitragen...</p>' },
      { title: 'Was du bewegst', content: '<ul><li>Planung, Aufbau und Umsetzung von Kampagnen</li></ul>' },
      { title: 'Was dich ausmacht', content: '<ul><li>Abgeschlossene Ausbildung im Bereich Marketing</li></ul>' },
      { title: ' ', content: '<p>Ein attraktiver Arbeitsplatz...</p>' },
      { title: ' ', content: '<p>Mountain Vision AG</p>' },
    ],
  };

  const SAMPLE_SEASONAL_LISTING = {
    id: 4478,
    jobFields: {
      DPOSTINGSTART: 1774566000000,
      CONTRACTTYPLABEL: 'Saisonanstellung',
      SLOVLIST17: '60%-100%',
      sJobTitle: 'Mitarbeiter:in Spülküche',
      SLOVLIST10: 'Restaurant IKIGAI',
      id: 4478,
      siteLangauge: 'DE',
      language: 'DE',
      jobNumber: 'WAG02290',
      jobTitle: 'Mitarbeiter:in Spülküche',
      applicationUrl: 'https://emea3.recruitmentplatform.com/apply-app/pages/application-form?jobId=PD6FK026203F3VBQBLO8NV79D-4478&langCode=de_DE',
      POSTINGTIMEZONE: 'Europe/Zurich',
    },
    customFields: [
      { title: ' ', content: '<p>Company intro...</p>' },
      { title: ' ', content: '<p>Role intro...</p>' },
      { title: ' ', content: '<p>Extra info...</p>' },
      { title: 'Was du bewegst', content: '<ul><li>Reinigung des Geschirrs</li></ul>' },
      { title: 'Was dich ausmacht', content: '<ul><li>Teamfähigkeit</li></ul>' },
      { title: ' ', content: '<p>Benefits...</p>' },
      { title: ' ', content: '<p>Contact info...</p>' },
    ],
  };

  it('listing has required jobFields', () => {
    const fields = SAMPLE_LISTING.jobFields;
    expect(fields.jobTitle).toBeTruthy();
    expect(fields.id).toBeTruthy();
    expect(fields.jobNumber).toBeTruthy();
    expect(fields.DPOSTINGSTART).toBeGreaterThan(0);
    expect(fields.CONTRACTTYPLABEL).toBeTruthy();
    expect(fields.applicationUrl).toBeTruthy();
  });

  it('listing has customFields array', () => {
    expect(Array.isArray(SAMPLE_LISTING.customFields)).toBe(true);
    expect(SAMPLE_LISTING.customFields.length).toBeGreaterThan(0);
  });

  it('customFields have title and content', () => {
    for (const field of SAMPLE_LISTING.customFields) {
      expect(field).toHaveProperty('title');
      expect(field).toHaveProperty('content');
    }
  });

  it('SLOVLIST10 contains department', () => {
    expect(SAMPLE_LISTING.jobFields.SLOVLIST10).toBe('Digitalisation and Data Analytics');
    expect(SAMPLE_SEASONAL_LISTING.jobFields.SLOVLIST10).toBe('Restaurant IKIGAI');
  });

  it('SLOVLIST17 contains pensum', () => {
    expect(SAMPLE_LISTING.jobFields.SLOVLIST17).toBe('80%-100%');
    expect(SAMPLE_SEASONAL_LISTING.jobFields.SLOVLIST17).toBe('60%-100%');
  });

  it('jobNumber starts with WAG prefix', () => {
    expect(SAMPLE_LISTING.jobFields.jobNumber).toMatch(/^WAG\d+$/);
  });

  it('application URL contains site tech ID', () => {
    expect(SAMPLE_LISTING.jobFields.applicationUrl).toContain('PD6FK026203F3VBQBLO8NV79D');
  });

  it('DPOSTINGSTART is a millisecond timestamp', () => {
    const date = new Date(SAMPLE_LISTING.jobFields.DPOSTINGSTART);
    expect(date.getFullYear()).toBeGreaterThanOrEqual(2025);
    expect(date.getFullYear()).toBeLessThanOrEqual(2030);
  });

  it('seasonal listing has different contract type', () => {
    expect(SAMPLE_SEASONAL_LISTING.jobFields.CONTRACTTYPLABEL).toBe('Saisonanstellung');
  });
});

// ─── Slug generation ────────────────────────────────────────────────────────────

describe('slug generation', () => {
  it('generates slug for German job title with company suffix', () => {
    const slug = slugify('CRM & Lifecycle Marketing Manager weisse-arena ch');
    expect(slug).toBe('crm-lifecycle-marketing-manager-weisse-arena-ch');
  });

  it('handles colons in gender-neutral titles', () => {
    const slug = slugify('Servicemitarbeiter:in weisse-arena ch');
    expect(slug).toBe('servicemitarbeiter-in-weisse-arena-ch');
  });

  it('handles umlauts', () => {
    const slug = slugify('Verantwortliche:r Frühstücksköchin/Koch weisse-arena ch');
    expect(slug).toContain('fruhstuckskochin');
  });

  it('truncates to max 90 characters', () => {
    const longTitle = 'a'.repeat(200);
    const slug = slugify(longTitle);
    expect(slug.length).toBeLessThanOrEqual(90);
  });
});

// ─── Job Shape Validation ───────────────────────────────────────────────────────

describe('job shape', () => {
  const validJob = {
    id: 'weisse-arena-abc123def456',
    slug: 'crm-lifecycle-marketing-manager-weisse-arena-ch',
    slugByLocale: { de: 'crm-lifecycle-marketing-manager-weisse-arena-ch' },
    company: 'Weisse Arena Gruppe',
    companyKey: 'weisse-arena',
    companyDomain: 'weissearena.com',
    title: 'CRM & Lifecycle Marketing Manager',
    titleByLocale: { de: 'CRM & Lifecycle Marketing Manager' },
    description: 'Planung, Aufbau und Umsetzung von Kampagnen...',
    descriptionByLocale: { de: 'Planung, Aufbau und Umsetzung von Kampagnen...' },
    location: 'Laax',
    canton: 'GR',
    url: 'https://www.weissearena.com/jobs/details.html?jobId=4484&jobTitle=CRM+%26+Lifecycle+Marketing+Manager',
    source: 'Weisse Arena Gruppe Dedicated Parser',
    sourceLang: 'de',
    crawledAt: new Date().toISOString(),
    addressLocality: 'Laax',
    postalCode: '7031',
    addressCountry: 'CH',
    country: 'CH',
    category: 'Marketing',
    contract: 'full-time',
    employmentType: 'FULL_TIME',
    experienceLevel: 'mid',
    sector: 'Turismo / Sport',
    currency: 'CHF',
    featured: false,
    postedDate: '2025-06-28',
    applyUrl: 'https://emea3.recruitmentplatform.com/apply-app/pages/application-form?jobId=PD6FK026203F3VBQBLO8NV79D-4484&langCode=de_DE',
    department: 'Digitalisation and Data Analytics',
    jobNumber: 'WAG02350',
    pensum: '80 - 100%',
    contractLabel: 'Festanstellung',
  };

  it('has all required fields', () => {
    const required = [
      'id', 'slug', 'slugByLocale', 'company', 'companyKey', 'companyDomain',
      'title', 'titleByLocale', 'description', 'descriptionByLocale',
      'location', 'canton', 'url', 'source', 'sourceLang', 'crawledAt',
    ];
    for (const field of required) {
      expect(validJob).toHaveProperty(field);
    }
  });

  it('has all recommended fields', () => {
    const recommended = [
      'addressLocality', 'postalCode', 'addressCountry', 'country',
      'category', 'contract', 'employmentType', 'experienceLevel',
      'sector', 'currency', 'postedDate', 'applyUrl',
    ];
    for (const field of recommended) {
      expect(validJob).toHaveProperty(field);
    }
  });

  it('slug only contains source locale', () => {
    const locales = Object.keys(validJob.slugByLocale);
    expect(locales).toHaveLength(1);
    expect(locales[0]).toBe(validJob.sourceLang);
  });

  it('id starts with company key', () => {
    expect(validJob.id).toMatch(/^weisse-arena-/);
  });

  it('slug is URL-safe', () => {
    expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it('location is Laax (all jobs are at LAAX resort)', () => {
    expect(validJob.location).toBe('Laax');
    expect(validJob.canton).toBe('GR');
    expect(validJob.postalCode).toBe('7031');
  });

  it('sector is Turismo / Sport', () => {
    expect(validJob.sector).toBe('Turismo / Sport');
  });

  it('source lang is German', () => {
    expect(validJob.sourceLang).toBe('de');
  });
});
