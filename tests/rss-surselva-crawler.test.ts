/**
 * Tests for the Regionalspital Surselva (RSS) dedicated job crawler.
 *
 * Verifies:
 *   - Ostendis JobPublisher API response parsing
 *   - Detail page JSON-LD extraction
 *   - Job object construction from listing + detail data
 *   - Employment type inference from title percentages
 *   - Canton assignment (default GR)
 *   - Category detection for healthcare roles
 *   - Experience level detection
 *   - Slug generation
 *   - Company job identification
 *   - Trusted domain detection (rss.ch + ostendis.com)
 */
import { describe, it, expect } from 'vitest';
import {
  RSS_SURSELVA_KEY,
  RSS_SURSELVA_COMPANY_NAME,
  isRssSurselvaJob,
  isTrustedDomain,
  parseOstendisJob,
  parseDetailPageJsonLd,
  detectCategory,
  detectExperienceLevel,
  inferEmploymentType,
} from '../scripts/lib/rss-surselva-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// ─── Constants ──────────────────────────────────────────────────────────────────

describe('RSS Surselva crawler constants', () => {
  it('has correct company key', () => {
    expect(RSS_SURSELVA_KEY).toBe('rss-surselva');
  });

  it('has correct company name', () => {
    expect(RSS_SURSELVA_COMPANY_NAME).toBe('Regionalspital Surselva');
  });
});

// ─── isRssSurselvaJob ───────────────────────────────────────────────────────────

describe('isRssSurselvaJob', () => {
  it('matches by companyKey', () => {
    expect(isRssSurselvaJob({ companyKey: 'rss-surselva' })).toBe(true);
  });

  it('matches by company name', () => {
    expect(isRssSurselvaJob({ company: 'Regionalspital Surselva' })).toBe(true);
  });

  it('matches by company name case-insensitive', () => {
    expect(isRssSurselvaJob({ company: 'REGIONALSPITAL SURSELVA AG' })).toBe(true);
  });

  it('matches by URL domain', () => {
    expect(isRssSurselvaJob({ url: 'https://rss.ch/jobs/123' })).toBe(true);
  });

  it('matches by URL subdomain', () => {
    expect(isRssSurselvaJob({ url: 'https://www.rss.ch/jobs-und-karriere/' })).toBe(true);
  });

  it('rejects unrelated jobs', () => {
    expect(isRssSurselvaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
  });

  it('handles null/undefined gracefully', () => {
    expect(isRssSurselvaJob(null)).toBe(false);
    expect(isRssSurselvaJob(undefined)).toBe(false);
    expect(isRssSurselvaJob({})).toBe(false);
  });
});

// ─── isTrustedDomain ────────────────────────────────────────────────────────────

describe('isTrustedDomain', () => {
  it('trusts primary domain', () => {
    expect(isTrustedDomain('https://rss.ch/careers/job-123')).toBe(true);
  });

  it('trusts www subdomain', () => {
    expect(isTrustedDomain('https://www.rss.ch/jobs-und-karriere/')).toBe(true);
  });

  it('trusts link.ostendis.com (detail pages)', () => {
    expect(isTrustedDomain('https://link.ostendis.com/publication/test/abc123')).toBe(true);
  });

  it('trusts odm.ostendis.com (API)', () => {
    expect(isTrustedDomain('https://odm.ostendis.com/ojp/data/v54/jobs/token/DE')).toBe(true);
  });

  it('trusts other ostendis subdomains', () => {
    expect(isTrustedDomain('https://cdn.ostendis.com/assets/logo.png')).toBe(true);
  });

  it('rejects other domains', () => {
    expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
  });

  it('handles invalid URLs', () => {
    expect(isTrustedDomain('')).toBe(false);
    expect(isTrustedDomain('not-a-url')).toBe(false);
  });
});

// ─── detectCategory ─────────────────────────────────────────────────────────────

describe('detectCategory', () => {
  it('detects medical roles', () => {
    expect(detectCategory('Hausärztin / Hausarzt 50-100 %')).toBe('Medicina');
    expect(detectCategory('Leitende Ärztin / Leitender Arzt Pädiatrie')).toBe('Medicina');
    expect(detectCategory('Oberarzt Chirurgie')).toBe('Medicina');
  });

  it('detects nursing roles', () => {
    expect(detectCategory('Pflegefachperson HF 80-100%')).toBe('Infermieristica');
    expect(detectCategory('Fachperson Gesundheit EFZ')).toBe('Infermieristica');
    expect(detectCategory('Hebamme 60-80%')).toBe('Infermieristica');
  });

  it('detects admin roles', () => {
    expect(detectCategory('Arztsekretär*in 80-100 %', 'Arztsekretariate')).toBe('Amministrazione');
    expect(detectCategory('Empfangsmitarbeiter/in')).toBe('Amministrazione');
  });

  it('detects therapy roles', () => {
    expect(detectCategory('Physiotherapeut/in 80-100%')).toBe('Terapia');
    expect(detectCategory('Ergotherapeutin 60%')).toBe('Terapia');
  });

  it('detects hospitality/kitchen roles', () => {
    expect(detectCategory('Koch / Köchin 80-100%')).toBe('Ristorazione');
    expect(detectCategory('Mitarbeiter/in Hotellerie')).toBe('Ristorazione');
  });

  it('detects technical roles', () => {
    expect(detectCategory('Haustechniker 100%')).toBe('Tecnica');
    expect(detectCategory('Elektroinstallateur')).toBe('Tecnica');
  });

  it('detects IT roles', () => {
    expect(detectCategory('Informatiker/in EFZ')).toBe('IT');
  });

  it('detects training/apprentice roles', () => {
    expect(detectCategory('Lehrperson Pflege')).toBe('Formazione');
    expect(detectCategory('Lernende/r FaGe')).toBe('Formazione');
  });

  it('detects laboratory roles', () => {
    expect(detectCategory('Biomedizinische Analytikerin')).toBe('Laboratorio');
    expect(detectCategory('MTRA Radiologie')).toBe('Laboratorio');
  });

  it('defaults to Sanita for unmatched healthcare', () => {
    expect(detectCategory('Mitarbeiter/in Notfall')).toBe('Sanità');
  });

  it('uses department for detection', () => {
    expect(detectCategory('Mitarbeiter/in', 'Ärzte')).toBe('Sanità');
    expect(detectCategory('Teamleiter/in', 'Verwaltung')).toBe('Amministrazione');
  });
});

// ─── detectExperienceLevel ──────────────────────────────────────────────────────

describe('detectExperienceLevel', () => {
  it('detects senior/leadership roles', () => {
    expect(detectExperienceLevel('Leitende Ärztin / Leitender Arzt Pädiatrie')).toBe('senior');
    expect(detectExperienceLevel('Oberarzt Chirurgie')).toBe('senior');
    expect(detectExperienceLevel('Stv. Leiter Pflege')).toBe('senior');
    expect(detectExperienceLevel('Chefarzt Innere Medizin')).toBe('senior');
  });

  it('detects intern/apprentice roles', () => {
    expect(detectExperienceLevel('Praktikum Pflege')).toBe('intern');
    expect(detectExperienceLevel('Lernende/r FaGe')).toBe('intern');
  });

  it('defaults to mid for regular roles', () => {
    expect(detectExperienceLevel('Pflegefachperson HF 80-100%')).toBe('mid');
    expect(detectExperienceLevel('Hausärztin / Hausarzt 50-100 %')).toBe('mid');
  });
});

// ─── inferEmploymentType ────────────────────────────────────────────────────────

describe('inferEmploymentType', () => {
  it('detects full-time from 100%', () => {
    expect(inferEmploymentType('Hausärztin 100%')).toBe('FULL_TIME');
  });

  it('detects full-time from 80-100%', () => {
    expect(inferEmploymentType('Pflegefachperson HF 80-100%')).toBe('FULL_TIME');
  });

  it('detects part-time from 50-80%', () => {
    expect(inferEmploymentType('Arztsekretärin 50-80%')).toBe('PART_TIME');
  });

  it('detects part-time from 60%', () => {
    expect(inferEmploymentType('Ergotherapeutin 60%')).toBe('PART_TIME');
  });

  it('handles range with spaces and dash variants', () => {
    expect(inferEmploymentType('Koch / Köchin 80 - 100 %')).toBe('FULL_TIME');
    expect(inferEmploymentType('Mitarbeiter 50 – 80 %')).toBe('PART_TIME');
  });

  it('defaults to FULL_TIME when no percentage', () => {
    expect(inferEmploymentType('Oberarzt Chirurgie')).toBe('FULL_TIME');
  });
});

// ─── parseDetailPageJsonLd ──────────────────────────────────────────────────────

describe('parseDetailPageJsonLd', () => {
  const sampleJsonLd = JSON.stringify({
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: 'Arztsekretär*in 80-100 %',
    description: '<div><p>Interessante Stelle im Spital.</p><ul><li>Aufgabe 1</li><li>Aufgabe 2</li></ul></div>',
    datePosted: '2026-03-15',
    employmentType: ['PART_TIME', 'FULL_TIME'],
    hiringOrganization: {
      '@type': 'Organization',
      name: 'Regionalspital Surselva AG',
    },
    jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        streetAddress: 'Spitalstrasse 6',
        addressLocality: 'Ilanz',
        postalCode: '7130',
        addressRegion: 'GR',
        addressCountry: 'CH',
      },
    },
  });

  const sampleHtml = `<html><head><script type="application/ld+json">${sampleJsonLd}</script></head><body></body></html>`;

  it('extracts description from JSON-LD', () => {
    const result = parseDetailPageJsonLd(sampleHtml);
    expect(result.description).toContain('Interessante Stelle im Spital');
    expect(result.description).toContain('Aufgabe 1');
  });

  it('strips HTML tags from description', () => {
    const result = parseDetailPageJsonLd(sampleHtml);
    expect(result.description).not.toContain('<div>');
    expect(result.description).not.toContain('<p>');
    expect(result.description).not.toContain('<li>');
  });

  it('extracts datePosted', () => {
    const result = parseDetailPageJsonLd(sampleHtml);
    expect(result.datePosted).toBe('2026-03-15');
  });

  it('extracts employmentType from array', () => {
    const result = parseDetailPageJsonLd(sampleHtml);
    expect(result.employmentType).toBe('FULL_TIME');
  });

  it('extracts location fields', () => {
    const result = parseDetailPageJsonLd(sampleHtml);
    expect(result.streetAddress).toBe('Spitalstrasse 6');
    expect(result.addressLocality).toBe('Ilanz');
    expect(result.postalCode).toBe('7130');
    expect(result.addressRegion).toBe('GR');
  });

  it('returns defaults when no JSON-LD present', () => {
    const result = parseDetailPageJsonLd('<html><body>No structured data</body></html>');
    expect(result.description).toBe('');
    expect(result.datePosted).toBe('');
    expect(result.employmentType).toBe('');
  });

  it('returns defaults when JSON-LD is not JobPosting', () => {
    const nonJobLd = JSON.stringify({ '@type': 'Organization', name: 'Test' });
    const html = `<html><head><script type="application/ld+json">${nonJobLd}</script></head></html>`;
    const result = parseDetailPageJsonLd(html);
    expect(result.description).toBe('');
  });

  it('handles single employmentType string', () => {
    const singleTypeLd = JSON.stringify({
      '@context': 'https://schema.org/',
      '@type': 'JobPosting',
      title: 'Test',
      employmentType: 'PART_TIME',
    });
    const html = `<html><head><script type="application/ld+json">${singleTypeLd}</script></head></html>`;
    const result = parseDetailPageJsonLd(html);
    expect(result.employmentType).toBe('PART_TIME');
  });

  it('handles malformed JSON gracefully', () => {
    const html = '<html><head><script type="application/ld+json">{invalid json</script></head></html>';
    const result = parseDetailPageJsonLd(html);
    expect(result.description).toBe('');
    expect(result.datePosted).toBe('');
  });
});

// ─── parseOstendisJob ───────────────────────────────────────────────────────────

describe('parseOstendisJob', () => {
  const sampleEntry = {
    id: 57574,
    title: 'Hausärztin / Hausarzt 50-100 %',
    country: 'Schweiz',
    countrycode: 'CH',
    city: 'Ilanz',
    zip: '7130',
    department: 'Ärzte',
    detail: 'https://link.ostendis.com/publication/hausaerztin-hausarzt/abc123',
    action: 'https://link.ostendis.com/cvdropper/def456/DE?src=abc123',
    timestamp: '1719273600',
  };

  const sampleDetail = {
    description: 'Selbständige Patientenversorgung in einer modernen Gruppenpraxis. Wir bieten ein motiviertes Team, flexible Arbeitszeiten und die Möglichkeit zur fachlichen Weiterentwicklung in einem angenehmen Arbeitsumfeld.',
    datePosted: '2024-06-25',
    employmentType: 'FULL_TIME',
    streetAddress: 'Spitalstrasse 6',
    addressLocality: 'Ilanz',
    postalCode: '7130',
    addressRegion: 'GR',
  };

  it('builds a complete job object', () => {
    const job = parseOstendisJob(sampleEntry, sampleDetail);
    expect(job).not.toBeNull();
    expect(job.title).toBe('Hausärztin / Hausarzt 50-100 %');
    expect(job.company).toBe('Regionalspital Surselva');
    expect(job.companyKey).toBe('rss-surselva');
  });

  it('sets correct location from Ostendis entry', () => {
    const job = parseOstendisJob(sampleEntry, sampleDetail);
    expect(job.location).toBe('Ilanz');
    expect(job.canton).toBe('GR');
    expect(job.postalCode).toBe('7130');
  });

  it('uses detail page description when available', () => {
    const job = parseOstendisJob(sampleEntry, sampleDetail);
    expect(job.description).toBe('Selbständige Patientenversorgung in einer modernen Gruppenpraxis. Wir bieten ein motiviertes Team, flexible Arbeitszeiten und die Möglichkeit zur fachlichen Weiterentwicklung in einem angenehmen Arbeitsumfeld.');
  });

  it('falls back to title-based description with boilerplate when detail is short', () => {
    const job = parseOstendisJob(sampleEntry, { description: 'Short' });
    expect(job.description).toContain('Hausärztin / Hausarzt');
    expect(job.description).toContain('Regionalspital Surselva');
    expect(job.description).toContain('Ärzte');
    expect(job.description).toContain('Grund- und Notfallversorgung');
    expect(job.description.length).toBeGreaterThanOrEqual(150);
  });

  it('uses detail page datePosted', () => {
    const job = parseOstendisJob(sampleEntry, sampleDetail);
    expect(job.postedDate).toBe('2024-06-25');
  });

  it('uses detail page employmentType', () => {
    const job = parseOstendisJob(sampleEntry, sampleDetail);
    expect(job.employmentType).toBe('FULL_TIME');
  });

  it('infers employment type from title when detail unavailable', () => {
    const job = parseOstendisJob(sampleEntry, {});
    expect(job.employmentType).toBe('FULL_TIME'); // 50-100% → max 100 ≥ 90
  });

  it('generates stable ID from Ostendis job ID', () => {
    const job = parseOstendisJob(sampleEntry, sampleDetail);
    expect(job.id).toMatch(/^rss-surselva-[a-f0-9]{12}$/);
  });

  it('generates same ID for same Ostendis job ID', () => {
    const job1 = parseOstendisJob(sampleEntry, sampleDetail);
    const job2 = parseOstendisJob(sampleEntry, sampleDetail);
    expect(job1.id).toBe(job2.id);
  });

  it('sets detail URL as public URL', () => {
    const job = parseOstendisJob(sampleEntry, sampleDetail);
    expect(job.url).toBe('https://link.ostendis.com/publication/hausaerztin-hausarzt/abc123');
  });

  it('sets apply URL from action field', () => {
    const job = parseOstendisJob(sampleEntry, sampleDetail);
    expect(job.applyUrl).toBe('https://link.ostendis.com/cvdropper/def456/DE?src=abc123');
  });

  it('detects category from title and department', () => {
    const job = parseOstendisJob(sampleEntry, sampleDetail);
    expect(job.category).toBe('Medicina');
  });

  it('sets sector to healthcare', () => {
    const job = parseOstendisJob(sampleEntry, sampleDetail);
    expect(job.sector).toBe('Sanità / Assistenza');
  });

  it('extracts pensum from title', () => {
    const job = parseOstendisJob(sampleEntry, sampleDetail);
    expect(job.pensumMin).toBe(50);
    expect(job.pensumMax).toBe(100);
    expect(job.pensum).toBe('50 - 100%');
  });

  it('includes department when available', () => {
    const job = parseOstendisJob(sampleEntry, sampleDetail);
    expect(job.department).toBe('Ärzte');
  });

  it('uses street address from detail page', () => {
    const job = parseOstendisJob(sampleEntry, sampleDetail);
    expect(job.streetAddress).toBe('Spitalstrasse 6');
  });

  it('defaults location to Ilanz when city is empty', () => {
    const entryNoCity = { ...sampleEntry, city: '' };
    const job = parseOstendisJob(entryNoCity, {});
    expect(job.location).toBe('Ilanz');
  });

  it('defaults postal code to 7130 when missing', () => {
    const entryNoZip = { ...sampleEntry, zip: '' };
    const job = parseOstendisJob(entryNoZip, {});
    expect(job.postalCode).toBe('7130');
  });

  it('returns null for titles shorter than 3 characters', () => {
    const shortTitle = { ...sampleEntry, title: 'AB' };
    expect(parseOstendisJob(shortTitle)).toBeNull();
  });

  it('returns null for empty title', () => {
    const noTitle = { ...sampleEntry, title: '' };
    expect(parseOstendisJob(noTitle)).toBeNull();
  });

  it('sets sourceLang to de', () => {
    const job = parseOstendisJob(sampleEntry, sampleDetail);
    expect(job.sourceLang).toBe('de');
  });

  it('slug contains company suffix', () => {
    const job = parseOstendisJob(sampleEntry, sampleDetail);
    expect(job.slug).toContain('rss-surselva-ch');
  });

  it('handles entry without department', () => {
    const noDept = { ...sampleEntry, department: '' };
    const job = parseOstendisJob(noDept, sampleDetail);
    expect(job).not.toBeNull();
    expect(job.department).toBeUndefined();
  });

  it('handles single percentage in title', () => {
    const singlePct = { ...sampleEntry, title: 'Koch 100%' };
    const job = parseOstendisJob(singlePct, {});
    expect(job.pensumMin).toBe(100);
    expect(job.pensumMax).toBe(100);
    expect(job.pensum).toBe('100%');
    expect(job.contract).toBe('full-time');
  });

  it('sets part-time contract for low pensum', () => {
    const partTime = { ...sampleEntry, title: 'Sekretärin 40-60%' };
    const job = parseOstendisJob(partTime, {});
    expect(job.contract).toBe('part-time');
    expect(job.employmentType).toBe('PART_TIME');
  });
});

// ─── slugify ────────────────────────────────────────────────────────────────────

describe('slugify', () => {
  it('converts title to URL-safe slug', () => {
    expect(slugify('Software Engineer (m/f/d)')).toBe('software-engineer-m-f-d');
  });

  it('strips diacritics', () => {
    expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
  });

  it('handles German umlauts', () => {
    const slug = slugify('Hausärztin Hausarzt rss-surselva ch');
    expect(slug).toContain('hausarztin');
    expect(slug).toContain('rss-surselva-ch');
  });

  it('builds slug with company suffix', () => {
    expect(slugify('Developer rss-surselva ch')).toBe('developer-rss-surselva-ch');
  });

  it('respects max length', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(90);
  });
});

// ─── Job Shape Validation ───────────────────────────────────────────────────────

describe('job shape', () => {
  const sampleEntry = {
    id: 57574,
    title: 'Pflegefachperson HF 80-100%',
    city: 'Ilanz',
    zip: '7130',
    department: 'Pflege',
    detail: 'https://link.ostendis.com/publication/pflegefachperson/abc123',
    action: 'https://link.ostendis.com/cvdropper/def456/DE',
  };

  const validJob = parseOstendisJob(sampleEntry, {
    description: 'Wir suchen eine erfahrene Pflegefachperson HF für unser Team in Ilanz.',
    datePosted: '2026-04-01',
    employmentType: 'FULL_TIME',
    streetAddress: 'Spitalstrasse 6',
    addressLocality: 'Ilanz',
    postalCode: '7130',
    addressRegion: 'GR',
  });

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

  it('has all recommended fields', () => {
    const recommended = [
      'addressLocality', 'postalCode', 'streetAddress', 'addressCountry',
      'country', 'category', 'contract', 'employmentType',
      'experienceLevel', 'sector', 'currency', 'postedDate', 'applyUrl',
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
    expect(validJob.id).toMatch(/^rss-surselva-/);
  });

  it('slug is URL-safe', () => {
    expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it('has correct company metadata', () => {
    expect(validJob.company).toBe('Regionalspital Surselva');
    expect(validJob.companyKey).toBe('rss-surselva');
    expect(validJob.companyDomain).toBe('rss.ch');
  });

  it('has correct source', () => {
    expect(validJob.source).toBe('Regionalspital Surselva Dedicated Parser');
  });

  it('has correct canton for Ilanz', () => {
    expect(validJob.canton).toBe('GR');
  });

  it('has valid crawledAt timestamp', () => {
    expect(new Date(validJob.crawledAt).getTime()).not.toBeNaN();
  });
});
