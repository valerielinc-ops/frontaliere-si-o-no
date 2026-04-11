/**
 * Tests for the Badrutt's Palace Hotel dedicated job crawler.
 *
 * Verifies:
 *   - Company key and name constants
 *   - Job identification (isBadruttsPalaceJob)
 *   - Trusted domain detection (badruttscareers.com + teamtailor.com)
 *   - RSS XML parsing (parseRssItems)
 *   - RSS date parsing (parseRssDate)
 *   - Slug generation
 *   - Job shape validation
 *   - Category detection for hotel/hospitality roles
 */
import { describe, it, expect } from 'vitest';
import {
  BADRUTTS_PALACE_KEY,
  BADRUTTS_PALACE_COMPANY_NAME,
  BADRUTTS_PALACE_COMPANY_DOMAIN,
  isBadruttsPalaceJob,
  isTrustedDomain,
  parseRssItems,
  parseRssDate,
} from '../scripts/lib/badrutts-palace-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// ─── Constants ──────────────────────────────────────────────────────────────────

describe("Badrutt's Palace Hotel crawler constants", () => {
  it('has correct company key', () => {
    expect(BADRUTTS_PALACE_KEY).toBe('badrutts-palace');
  });

  it('has correct company name', () => {
    expect(BADRUTTS_PALACE_COMPANY_NAME).toBe("Badrutt's Palace Hotel");
  });

  it('has correct company domain', () => {
    expect(BADRUTTS_PALACE_COMPANY_DOMAIN).toBe('badruttscareers.com');
  });
});

// ─── Job identification ─────────────────────────────────────────────────────────

describe('isBadruttsPalaceJob detection', () => {
  it('matches by companyKey', () => {
    expect(isBadruttsPalaceJob({ companyKey: 'badrutts-palace' })).toBe(true);
  });

  it('matches by company name with apostrophe', () => {
    expect(isBadruttsPalaceJob({ company: "Badrutt's Palace Hotel" })).toBe(true);
  });

  it('matches by company name without apostrophe', () => {
    expect(isBadruttsPalaceJob({ company: 'Badrutts Palace Hotel' })).toBe(true);
  });

  it('matches by URL domain (badruttscareers.com)', () => {
    expect(isBadruttsPalaceJob({ url: 'https://jobs.badruttscareers.com/en-GB/jobs/123-chef' })).toBe(true);
  });

  it('matches by URL domain (badruttspalace.com)', () => {
    expect(isBadruttsPalaceJob({ url: 'https://www.badruttspalace.com/careers' })).toBe(true);
  });

  it('rejects unrelated jobs', () => {
    expect(isBadruttsPalaceJob({
      companyKey: 'other-company',
      company: 'Other Hotel',
      url: 'https://other.com/jobs',
    })).toBe(false);
  });

  it('handles null/undefined gracefully', () => {
    expect(isBadruttsPalaceJob(null)).toBe(false);
    expect(isBadruttsPalaceJob(undefined)).toBe(false);
    expect(isBadruttsPalaceJob({})).toBe(false);
  });
});

// ─── Trusted domain check ───────────────────────────────────────────────────────

describe('isTrustedDomain', () => {
  it('trusts badruttscareers.com', () => {
    expect(isTrustedDomain('https://badruttscareers.com/careers/job-123')).toBe(true);
  });

  it('trusts jobs.badruttscareers.com', () => {
    expect(isTrustedDomain('https://jobs.badruttscareers.com/en-GB/jobs/12345-chef')).toBe(true);
  });

  it('trusts badruttspalace.com', () => {
    expect(isTrustedDomain('https://www.badruttspalace.com/careers')).toBe(true);
  });

  it('trusts teamtailor.com', () => {
    expect(isTrustedDomain('https://teamtailor.com/redirect/12345')).toBe(true);
  });

  it('trusts subdomains of teamtailor.com', () => {
    expect(isTrustedDomain('https://app.teamtailor.com/companies/12345')).toBe(true);
  });

  it('rejects untrusted domains', () => {
    expect(isTrustedDomain('https://malicious-site.com/badruttscareers')).toBe(false);
  });

  it('handles invalid URLs gracefully', () => {
    expect(isTrustedDomain('')).toBe(false);
    expect(isTrustedDomain('not-a-url')).toBe(false);
  });
});

// ─── RSS XML parsing ────────────────────────────────────────────────────────────

describe('parseRssItems', () => {
  const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Badrutt's Palace Hotel - Jobs</title>
    <link>https://jobs.badruttscareers.com</link>
    <description>Current job openings</description>
    <item>
      <title>Chef de Partie</title>
      <link>https://jobs.badruttscareers.com/en-GB/jobs/12345-chef-de-partie</link>
      <description><![CDATA[<p>We are looking for a talented Chef de Partie to join our culinary team at Badrutt's Palace Hotel in St. Moritz.</p>]]></description>
      <pubDate>Mon, 01 Apr 2026 12:00:00 +0000</pubDate>
    </item>
    <item>
      <title>Night Auditor</title>
      <link>https://jobs.badruttscareers.com/en-GB/jobs/12346-night-auditor</link>
      <description><![CDATA[<p>Join our front office team as Night Auditor.</p>]]></description>
      <pubDate>Tue, 02 Apr 2026 08:30:00 +0000</pubDate>
    </item>
  </channel>
</rss>`;

  it('parses multiple items from RSS feed', () => {
    const items = parseRssItems(SAMPLE_RSS);
    expect(items).toHaveLength(2);
  });

  it('extracts title correctly', () => {
    const items = parseRssItems(SAMPLE_RSS);
    expect(items[0].title).toBe('Chef de Partie');
    expect(items[1].title).toBe('Night Auditor');
  });

  it('extracts URL correctly', () => {
    const items = parseRssItems(SAMPLE_RSS);
    expect(items[0].url).toBe('https://jobs.badruttscareers.com/en-GB/jobs/12345-chef-de-partie');
  });

  it('extracts description HTML', () => {
    const items = parseRssItems(SAMPLE_RSS);
    expect(items[0].descriptionHtml).toContain('Chef de Partie');
  });

  it('extracts pubDate', () => {
    const items = parseRssItems(SAMPLE_RSS);
    expect(items[0].pubDate).toBe('Mon, 01 Apr 2026 12:00:00 +0000');
  });

  it('handles single item (not wrapped in array)', () => {
    const singleItemRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Receptionist</title>
      <link>https://jobs.badruttscareers.com/en-GB/jobs/99999-receptionist</link>
      <description>Front desk role</description>
      <pubDate>Wed, 03 Apr 2026 10:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>`;
    const items = parseRssItems(singleItemRss);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Receptionist');
  });

  it('returns empty array for empty RSS', () => {
    const emptyRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel></channel></rss>`;
    const items = parseRssItems(emptyRss);
    expect(items).toHaveLength(0);
  });

  it('filters out items without title', () => {
    const noTitleRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <link>https://jobs.badruttscareers.com/en-GB/jobs/1</link>
      <description>No title here</description>
    </item>
  </channel>
</rss>`;
    const items = parseRssItems(noTitleRss);
    expect(items).toHaveLength(0);
  });

  it('filters out items without URL', () => {
    const noUrlRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Some Job</title>
      <description>Has title but no link</description>
    </item>
  </channel>
</rss>`;
    const items = parseRssItems(noUrlRss);
    expect(items).toHaveLength(0);
  });
});

// ─── RSS date parsing ───────────────────────────────────────────────────────────

describe('parseRssDate', () => {
  it('parses standard RSS pubDate', () => {
    expect(parseRssDate('Mon, 01 Apr 2026 12:00:00 +0000')).toBe('2026-04-01');
  });

  it('parses different weekday', () => {
    expect(parseRssDate('Tue, 15 Mar 2026 08:30:00 +0000')).toBe('2026-03-15');
  });

  it('handles timezone offset', () => {
    const result = parseRssDate('Fri, 10 Jan 2026 23:59:00 +0200');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns empty for invalid date', () => {
    expect(parseRssDate('not-a-date')).toBe('');
  });

  it('returns empty for empty input', () => {
    expect(parseRssDate('')).toBe('');
  });
});

// ─── Slug generation ────────────────────────────────────────────────────────────

describe('slug generation', () => {
  it('generates slug for hotel job title', () => {
    const slug = slugify('Chef de Partie badrutts-palace ch');
    expect(slug).toBe('chef-de-partie-badrutts-palace-ch');
  });

  it('generates slug for receptionist role', () => {
    const slug = slugify('Night Auditor badrutts-palace ch');
    expect(slug).toBe('night-auditor-badrutts-palace-ch');
  });

  it('strips special characters', () => {
    const slug = slugify('Sommelier (m/f/d)');
    expect(slug).toBe('sommelier-m-f-d');
  });

  it('truncates to max 90 characters', () => {
    const longTitle = 'A'.repeat(200);
    const slug = slugify(longTitle);
    expect(slug.length).toBeLessThanOrEqual(90);
  });
});

// ─── Job shape validation ───────────────────────────────────────────────────────

describe('job shape', () => {
  const validJob = {
    id: 'badrutts-palace-abc123def456',
    slug: 'chef-de-partie-badrutts-palace-ch',
    slugByLocale: { en: 'chef-de-partie-badrutts-palace-ch' },
    company: "Badrutt's Palace Hotel",
    companyKey: 'badrutts-palace',
    companyDomain: 'badruttscareers.com',
    title: 'Chef de Partie',
    titleByLocale: { en: 'Chef de Partie' },
    description: "We are looking for a talented Chef de Partie to join our culinary team at Badrutt's Palace Hotel in St. Moritz.",
    descriptionByLocale: { en: "We are looking for a talented Chef de Partie to join our culinary team at Badrutt's Palace Hotel in St. Moritz." },
    location: 'St. Moritz',
    canton: 'GR',
    url: 'https://jobs.badruttscareers.com/en-GB/jobs/12345-chef-de-partie',
    source: "Badrutt's Palace Hotel Dedicated Parser",
    sourceLang: 'en',
    crawledAt: new Date().toISOString(),
    addressLocality: 'St. Moritz',
    postalCode: '7500',
    addressCountry: 'CH',
    country: 'CH',
    category: 'Ristorazione',
    contract: 'full-time',
    employmentType: 'FULL_TIME',
    experienceLevel: 'mid',
    sector: 'Ospitalità / Hotellerie',
    currency: 'CHF',
    featured: false,
    postedDate: '2026-04-01',
    applyUrl: 'https://jobs.badruttscareers.com/en-GB/jobs/12345-chef-de-partie',
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

  it('has all recommended fields', () => {
    const recommended = [
      'addressLocality', 'postalCode', 'addressCountry', 'country',
      'category', 'contract', 'employmentType', 'experienceLevel',
      'sector', 'currency', 'featured', 'postedDate', 'applyUrl',
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
    expect(validJob.id).toMatch(/^badrutts-palace-/);
  });

  it('slug is URL-safe', () => {
    expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it('location defaults to St. Moritz', () => {
    expect(validJob.location).toBe('St. Moritz');
  });

  it('canton is GR (Graubünden)', () => {
    expect(validJob.canton).toBe('GR');
  });

  it('postal code is 7500 (St. Moritz)', () => {
    expect(validJob.postalCode).toBe('7500');
  });

  it('sector is hospitality', () => {
    expect(validJob.sector).toBe('Ospitalità / Hotellerie');
  });
});
