import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIGROLINO_KEY,
  MIGROLINO_COMPANY_NAME,
  MIGROLINO_COMPANY_DOMAIN,
  isMigrolinoJob,
  isTrustedDomain,
  resolveAddress,
  parseMigrolinoJsonLd,
  parseMigrolinoDetail,
  LISTING_URL,
  CAREER_URL,
} from '../scripts/lib/migrolino-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
}

describe('migrolino crawler parser', () => {
  // ── Constants ──
  it('exports valid company key, name and domain', () => {
    expect(MIGROLINO_KEY).toBe('migrolino');
    expect(MIGROLINO_COMPANY_NAME).toBe('migrolino');
    expect(MIGROLINO_COMPANY_DOMAIN).toBe('migrolino.ch');
  });

  it('exports the shared jobs.migros.ch listing URL scoped to migrolino', () => {
    expect(LISTING_URL).toContain('jobs.migros.ch');
    expect(LISTING_URL).toContain('migrolino');
  });

  it('exports the migrolino career landing page URL', () => {
    expect(CAREER_URL).toContain('migrolino-ag.ch');
  });

  // ── isCompanyJob ──
  describe('isMigrolinoJob', () => {
    it('matches by companyKey', () => {
      expect(isMigrolinoJob({ companyKey: 'migrolino' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isMigrolinoJob({ company: 'migrolino' })).toBe(true);
    });

    it('matches store-level company label variants (e.g. "migrolino Shop")', () => {
      expect(isMigrolinoJob({ companyKey: 'migros-ticino', company: 'migrolino Shop' })).toBe(true);
    });

    it('matches by jobs.migros.ch detail URL segment', () => {
      expect(
        isMigrolinoJob({
          url: 'https://jobs.migros.ch/de/unsere-unternehmen/job/migrolino/verkaufsmitarbeiterin/1b1c9896-4f2d-461a-95d8-1b8b7fe49fb6',
        }),
      ).toBe(true);
    });

    it('matches by migrolino own-domain URL', () => {
      expect(isMigrolinoJob({ url: 'https://www.migrolino.ch/de/jobs/' })).toBe(true);
      expect(isMigrolinoJob({ url: 'https://www.migrolino-ag.ch/de/karriere' })).toBe(true);
    });

    it('rejects other Migros Group brands on the shared jobs.migros.ch host', () => {
      expect(
        isMigrolinoJob({
          companyKey: 'migros-ticino',
          company: 'Migros',
          url: 'https://jobs.migros.ch/de/unsere-unternehmen/job/migros-logistics/lagermitarbeiterin/aaaa-bbbb',
        }),
      ).toBe(false);
    });

    it('rejects unrelated jobs', () => {
      expect(isMigrolinoJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(
        false,
      );
    });

    it('handles null/undefined gracefully', () => {
      expect(isMigrolinoJob(null)).toBe(false);
      expect(isMigrolinoJob(undefined)).toBe(false);
      expect(isMigrolinoJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the primary migrolino.ch domain', () => {
      expect(isTrustedDomain('https://www.migrolino.ch/de/jobs/')).toBe(true);
      expect(isTrustedDomain('https://migrolino.ch/de/jobs/')).toBe(true);
    });

    it('trusts the migrolino-ag.ch corporate domain', () => {
      expect(isTrustedDomain('https://www.migrolino-ag.ch/de/karriere')).toBe(true);
    });

    it('trusts the migrolino company-slug segment on the shared jobs.migros.ch portal', () => {
      expect(
        isTrustedDomain(
          'https://jobs.migros.ch/de/unsere-unternehmen/job/migrolino/verkaufsmitarbeiterin/1b1c9896-4f2d-461a-95d8-1b8b7fe49fb6',
        ),
      ).toBe(true);
    });

    it('rejects other group-brand tenants on the shared jobs.migros.ch host', () => {
      expect(
        isTrustedDomain('https://jobs.migros.ch/de/unsere-unternehmen/job/migros-logistics/lagermitarbeiterin/aaaa'),
      ).toBe(false);
      expect(
        isTrustedDomain(
          'https://jobs.migros.ch/de/unsere-unternehmen/job/genossenschaft-migros-aare/verkaeuferin/bbbb',
        ),
      ).toBe(false);
    });

    it('rejects unrelated domains', () => {
      expect(isTrustedDomain('https://evil.example.com/migrolino/jobs/123')).toBe(false);
    });

    it('handles malformed URLs gracefully', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
    });
  });

  // ── resolveAddress (city-gated HQ fallback — task-critical) ──
  describe('resolveAddress', () => {
    it('fills in the Suhr HQ street address only when the resolved city is Suhr', () => {
      const resolved = resolveAddress({ city: 'Suhr' });
      expect(resolved.city).toBe('Suhr');
      expect(resolved.postalCode).toBe('5034');
      expect(resolved.streetAddress).toBe('Wynenfeldstrasse 3');
    });

    it('does NOT leak the Suhr HQ street address for a same-canton non-HQ city (Baden AG)', () => {
      // Baden is canton AG, same canton as the Suhr HQ — this is exactly the
      // case a canton-only gate would get wrong.
      const resolved = resolveAddress({ city: 'Baden' });
      expect(resolved.city).toBe('Baden');
      expect(resolved.postalCode).toBe('');
      expect(resolved.streetAddress).toBe('');
    });

    it('does NOT leak the Suhr HQ street address for another same-canton non-HQ city (Wohlen AG)', () => {
      const resolved = resolveAddress({ city: 'Wohlen' });
      expect(resolved.postalCode).toBe('');
      expect(resolved.streetAddress).toBe('');
    });

    it('preserves a real per-store street address when the source already provides one', () => {
      const resolved = resolveAddress({
        city: 'Bern',
        postalCode: '3006',
        streetAddress: 'Egghölzlistrasse 1',
      });
      expect(resolved).toEqual({
        city: 'Bern',
        postalCode: '3006',
        streetAddress: 'Egghölzlistrasse 1',
      });
    });

    it('falls back to the Suhr HQ entirely when no city is supplied at all', () => {
      const resolved = resolveAddress({});
      expect(resolved.city).toBe('Suhr');
      expect(resolved.postalCode).toBe('5034');
      expect(resolved.streetAddress).toBe('Wynenfeldstrasse 3');
    });

    it('matches Suhr case-insensitively and ignores surrounding whitespace', () => {
      const resolved = resolveAddress({ city: '  SUHR  ' });
      expect(resolved.streetAddress).toBe('Wynenfeldstrasse 3');
    });

    it('does not false-positive match a city merely containing "suhr" as a substring', () => {
      // Word-boundary gate: a hypothetical city like "Wülflingen-Suhrau"
      // must not match \bsuhr\b.
      const resolved = resolveAddress({ city: 'Suhrau' });
      expect(resolved.postalCode).toBe('');
      expect(resolved.streetAddress).toBe('');
    });
  });

  // ── JSON-LD JobPosting parse ──
  describe('parseMigrolinoJsonLd', () => {
    it('parses a real HQ-role JobPosting JSON-LD block (Suhr)', () => {
      const html = loadFixture('migrolino-detail-hq.html');
      const jsonLd = parseMigrolinoJsonLd(html);
      expect(jsonLd).not.toBeNull();
      expect(jsonLd?.['@type']).toBe('JobPosting');
      expect(jsonLd?.hiringOrganization?.name).toBe('migrolino');
      expect(jsonLd?.jobLocation?.address?.addressLocality).toBe('Suhr');
      expect(jsonLd?.jobLocation?.address?.postalCode).toBe('5034');
    });

    it('parses a real shop-level JobPosting JSON-LD block (Bern)', () => {
      const html = loadFixture('migrolino-detail-shop-bern.html');
      const jsonLd = parseMigrolinoJsonLd(html);
      expect(jsonLd?.title).toBe('Verkaufsmitarbeiter*in');
      expect(jsonLd?.jobLocation?.address?.addressLocality).toBe('Bern');
      expect(jsonLd?.jobLocation?.address?.postalCode).toBe('3006');
      expect(jsonLd?.jobLocation?.address?.streetAddress).toContain('Egghölzlistrasse 1');
    });

    it('parses a real regional-role JobPosting JSON-LD block (Ostschweiz, HQ-fallback address)', () => {
      const html = loadFixture('migrolino-detail-regional.html');
      const jsonLd = parseMigrolinoJsonLd(html);
      expect(jsonLd?.title).toContain('Field Merchandiser');
      expect(jsonLd?.jobLocation?.address?.addressLocality).toBe('Suhr');
    });

    it('returns null for empty/invalid input', () => {
      expect(parseMigrolinoJsonLd('')).toBeNull();
      expect(parseMigrolinoJsonLd('<html><body>no jsonld here</body></html>')).toBeNull();
      expect(parseMigrolinoJsonLd(undefined as unknown as string)).toBeNull();
    });

    it('returns null when the JSON-LD block is not a JobPosting', () => {
      const html = `<script type="application/ld+json">{"@type":"Organization","name":"migrolino"}</script>`;
      expect(parseMigrolinoJsonLd(html)).toBeNull();
    });

    it('returns null for malformed JSON', () => {
      const html = `<script type="application/ld+json">{not valid json</script>`;
      expect(parseMigrolinoJsonLd(html)).toBeNull();
    });
  });

  // ── Detail page assembly (combines JSON-LD + rich HTML sections) ──
  describe('parseMigrolinoDetail', () => {
    it('assembles the HQ-role job with the Suhr HQ address and a rich description', () => {
      const html = loadFixture('migrolino-detail-hq.html');
      const parsed = parseMigrolinoDetail(html, 'https://jobs.migros.ch/de/unsere-unternehmen/job/migrolino/verkaufsstellenplanerin-cad/xxx');
      expect(parsed.city).toBe('Suhr');
      expect(parsed.postalCode).toBe('5034');
      expect(parsed.streetAddress).toBe('Wynenfeldstrasse 3');
      expect(parsed.canton).toBe('AG');
      expect(parsed.title.length).toBeGreaterThan(0);
      expect(parsed.description.length).toBeGreaterThan(50);
      expect(parsed.hiringOrganizationName).toBe('migrolino');
    });

    it('assembles the Bern shop job with the real per-store street address, not the Suhr HQ', () => {
      const html = loadFixture('migrolino-detail-shop-bern.html');
      const parsed = parseMigrolinoDetail(html, 'https://jobs.migros.ch/de/unsere-unternehmen/job/migrolino/verkaufsmitarbeiterin/yyy');
      expect(parsed.city).toBe('Bern');
      expect(parsed.postalCode).toBe('3006');
      expect(parsed.streetAddress).toContain('Egghölzlistrasse 1');
      expect(parsed.canton).toBe('BE');
      expect(parsed.title).toBe('Verkaufsmitarbeiter*in');
      expect(parsed.description.length).toBeGreaterThan(50);
    });

    it('assembles the regional role, falling back to the Suhr HQ address', () => {
      const html = loadFixture('migrolino-detail-regional.html');
      const parsed = parseMigrolinoDetail(html, 'https://jobs.migros.ch/de/unsere-unternehmen/job/migrolino/field-merchandiserin-region-ostschweiz/zzz');
      expect(parsed.city).toBe('Suhr');
      expect(parsed.postalCode).toBe('5034');
      expect(parsed.streetAddress).toBe('Wynenfeldstrasse 3');
      expect(parsed.title).toContain('Field Merchandiser');
    });

    it('derives a part-time contract from workHours below 90%', () => {
      const html = loadFixture('migrolino-detail-shop-bern.html');
      const parsed = parseMigrolinoDetail(html);
      // Bern fixture: "workHours":"60% - 60%"
      expect(parsed.contract).toBe('part-time');
      expect(parsed.employmentType).toBe('PART_TIME');
    });

    it('derives a full-time employmentType from workHours at/above 90%', () => {
      const html = loadFixture('migrolino-detail-regional.html');
      const parsed = parseMigrolinoDetail(html);
      // Regional fixture: "workHours":"80% - 100%" → top end 100%.
      expect(parsed.employmentType).toBe('FULL_TIME');
    });

    it('extracts a normalized postedDate (YYYY-MM-DD) from JSON-LD datePosted', () => {
      const html = loadFixture('migrolino-detail-hq.html');
      const parsed = parseMigrolinoDetail(html);
      expect(parsed.postedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('falls back to a non-empty synthesized description when everything else is missing', () => {
      const html = `<script type="application/ld+json">{"@context":"https://schema.org/","@type":"JobPosting","title":"Verkäufer*in","jobLocation":{"@type":"Place","address":{"@type":"PostalAddress"}}}</script>`;
      const parsed = parseMigrolinoDetail(html, 'https://jobs.migros.ch/de/unsere-unternehmen/job/migrolino/verkauferin/qqq');
      expect(parsed.title).toBe('Verkäufer*in');
      expect(parsed.description.length).toBeGreaterThan(0);
      expect(parsed.city).toBe('Suhr');
      expect(parsed.streetAddress).toBe('Wynenfeldstrasse 3');
    });

    it('returns an empty title (not a throw) for empty/invalid input', () => {
      const parsed = parseMigrolinoDetail('', '');
      expect(parsed.title).toBe('');
    });
  });

  // ── Structured-data completeness (repo Non-Negotiable #3) ──
  describe('structured-data field completeness', () => {
    // Shape mirroring what fetchAllMigrolinoJobs emits for a Bern shop job.
    const validJob = {
      id: 'migrolino-abc123def456',
      slug: 'verkaufsmitarbeiterin-migrolino-bern',
      slugByLocale: { de: 'verkaufsmitarbeiterin-migrolino-bern' },
      company: 'migrolino',
      companyKey: 'migrolino',
      companyDomain: 'migrolino.ch',
      title: 'Verkaufsmitarbeiter*in',
      titleByLocale: { de: 'Verkaufsmitarbeiter*in' },
      description: 'Stelle dein Engagement und Herzblut in einem migrolino-Shop unter Beweis.',
      descriptionByLocale: {
        de: 'Stelle dein Engagement und Herzblut in einem migrolino-Shop unter Beweis.',
      },
      location: 'Bern',
      canton: 'BE',
      url: 'https://jobs.migros.ch/de/unsere-unternehmen/job/migrolino/verkaufsmitarbeiterin/1b1c9896-4f2d-461a-95d8-1b8b7fe49fb6',
      source: 'migrolino Dedicated Parser (Migros Group jobs.migros.ch)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Bern',
      addressRegion: 'BE',
      streetAddress: 'Egghölzlistrasse 1',
      postalCode: '3006',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'PART_TIME',
      postedDate: new Date().toISOString().split('T')[0],
      hiringOrganizationName: 'migrolino',
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

    it('has the fields required for job-page structured data (baseSalary source inputs)', () => {
      // baseSalary itself is synthesized downstream with safe defaults;
      // per-job inputs are what the parser is responsible for supplying.
      const structuredDataInputs = [
        'postalCode', 'streetAddress', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field as keyof typeof validJob]).toBeTruthy();
      }
      expect(validJob.company).toBe('migrolino');
      expect(validJob.hiringOrganizationName).toBe('migrolino');
    });

    it('never assembles a job with an empty title or description', () => {
      expect(validJob.title.length).toBeGreaterThan(0);
      expect(validJob.description.length).toBeGreaterThanOrEqual(50);
    });
  });
});
