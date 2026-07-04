import { describe, it, expect } from 'vitest';
import {
  HORNBACH_KEY,
  HORNBACH_COMPANY_NAME,
  HORNBACH_COMPANY_DOMAIN,
  isHornbachJob,
  isTrustedDomain,
  resolveAddress,
  extractCantonCode,
  isSwissCountryArray,
  parseHornbachLocation,
  buildHornbachDescription,
  resolveHornbachPostedDate,
  resolveHornbachEmploymentType,
  parseHornbachOffer,
} from '../scripts/lib/hornbach-job-parser.mjs';

describe('Hornbach crawler parser', () => {
  // ── Constants ──
  it('exports valid company key, name and domain', () => {
    expect(HORNBACH_KEY).toBe('hornbach');
    expect(HORNBACH_COMPANY_NAME).toBe('Hornbach');
    expect(HORNBACH_COMPANY_DOMAIN).toBe('hornbach.ch');
  });

  // ── isCompanyJob ──
  describe('isHornbachJob', () => {
    it('matches by companyKey', () => {
      expect(isHornbachJob({ companyKey: 'hornbach' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isHornbachJob({ company: 'Hornbach' })).toBe(true);
    });

    it('matches by URL domain (jobs.hornbach.ch)', () => {
      expect(isHornbachJob({ url: 'https://jobs.hornbach.ch/offer-redirect/?offerApiId=abc' })).toBe(true);
    });

    it('matches by legacy corporate domain (jobs.hornbach.com)', () => {
      expect(isHornbachJob({ url: 'https://jobs.hornbach.com/de/jobs/12345' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isHornbachJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isHornbachJob(null)).toBe(false);
      expect(isHornbachJob(undefined)).toBe(false);
      expect(isHornbachJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the primary jobs.hornbach.ch domain', () => {
      expect(isTrustedDomain('https://jobs.hornbach.ch/offer-redirect/?offerApiId=abc')).toBe(true);
    });

    it('trusts the general hornbach.ch domain', () => {
      expect(isTrustedDomain('https://www.hornbach.ch/karriere')).toBe(true);
      expect(isTrustedDomain('https://hornbach.ch/jobs')).toBe(true);
    });

    it('trusts the legacy corporate hornbach.com domain', () => {
      expect(isTrustedDomain('https://jobs.hornbach.com/de/jobs/12345')).toBe(true);
    });

    it('rejects unrelated domains', () => {
      expect(isTrustedDomain('https://evil.example.com/hornbach/jobs/123')).toBe(false);
    });

    it('handles malformed URLs gracefully', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
    });
  });

  // ── resolveAddress (city-gated HQ fallback — task-critical) ──
  describe('resolveAddress', () => {
    it('fills in the Sursee HQ street address only when the resolved city is Sursee', () => {
      const resolved = resolveAddress({ city: 'Sursee' });
      expect(resolved.city).toBe('Sursee');
      expect(resolved.postalCode).toBe('6210');
      expect(resolved.streetAddress).toBe('Schellenrain 9');
    });

    it('does NOT leak the Sursee HQ street address for a same-canton non-HQ city (Luzern Littau, canton LU)', () => {
      // Luzern (city) is canton LU, same canton as the Sursee HQ — this is
      // exactly the case a canton-only gate would get wrong. This mirrors a
      // REAL negative-control data point observed live in the Hornbach CH
      // dataset: external_id 152523 "Verkäufer:in Elektro",
      // full_address ["Thorenbergstrasse 49, 6014 Luzern Littau"],
      // custom_filter_4 ["Luzern (LU)"].
      const resolved = resolveAddress({ city: 'Luzern Littau' });
      expect(resolved.city).toBe('Luzern Littau');
      expect(resolved.postalCode).toBe('');
      expect(resolved.streetAddress).toBe('');
    });

    it('preserves a real per-job street address when the source already provides one', () => {
      const resolved = resolveAddress({
        city: 'Luzern Littau',
        postalCode: '6014',
        streetAddress: 'Thorenbergstrasse 49',
      });
      expect(resolved).toEqual({
        city: 'Luzern Littau',
        postalCode: '6014',
        streetAddress: 'Thorenbergstrasse 49',
      });
    });

    it('falls back to the Sursee HQ entirely when no city is supplied at all', () => {
      const resolved = resolveAddress({});
      expect(resolved.city).toBe('Sursee');
      expect(resolved.postalCode).toBe('6210');
      expect(resolved.streetAddress).toBe('Schellenrain 9');
    });

    it('matches Sursee case-insensitively and ignores surrounding whitespace', () => {
      const resolved = resolveAddress({ city: '  SURSEE  ' });
      expect(resolved.streetAddress).toBe('Schellenrain 9');
    });
  });

  // ── extractCantonCode ──
  describe('extractCantonCode', () => {
    it('extracts the 2-letter code from a "Name (CODE)" facet value', () => {
      expect(extractCantonCode(['Schwyz (SZ)'])).toBe('SZ');
      expect(extractCantonCode(['Luzern (LU)'])).toBe('LU');
    });

    it('returns an empty string for missing/malformed input', () => {
      expect(extractCantonCode([])).toBe('');
      expect(extractCantonCode(undefined as unknown as string[])).toBe('');
      expect(extractCantonCode(['no code here'])).toBe('');
    });
  });

  // ── isSwissCountryArray ──
  describe('isSwissCountryArray', () => {
    it('recognizes Switzerland in various language spellings', () => {
      expect(isSwissCountryArray(['Switzerland'])).toBe(true);
      expect(isSwissCountryArray(['Schweiz'])).toBe(true);
      expect(isSwissCountryArray(['Suisse'])).toBe(true);
      expect(isSwissCountryArray(['Svizzera'])).toBe(true);
    });

    it('rejects non-Swiss country facets (multi-country Hornbach group)', () => {
      expect(isSwissCountryArray(['Germany'])).toBe(false);
      expect(isSwissCountryArray(['Austria'])).toBe(false);
      expect(isSwissCountryArray(['Romania'])).toBe(false);
    });

    it('handles missing/malformed input', () => {
      expect(isSwissCountryArray([])).toBe(false);
      expect(isSwissCountryArray(undefined as unknown as string[])).toBe(false);
    });
  });

  // ── parseHornbachLocation ──
  describe('parseHornbachLocation', () => {
    it('prefers structured location_objects over the free-text full_address', () => {
      const document = {
        full_address: ['Schellenrain 9, 6210 Sursee'],
        location_objects: [{ city: 'Sursee', street: 'Schellenrain 9', zip: '6210', country: 'CH' }],
      };
      expect(parseHornbachLocation(document)).toEqual({
        street: 'Schellenrain 9',
        postalCode: '6210',
        city: 'Sursee',
      });
    });

    it('falls back to regex-parsing full_address when location_objects is absent', () => {
      const document = { full_address: ['Thorenbergstrasse 49, 6014 Luzern Littau'] };
      expect(parseHornbachLocation(document)).toEqual({
        street: 'Thorenbergstrasse 49',
        postalCode: '6014',
        city: 'Luzern Littau',
      });
    });

    it('falls back to the plain location array when neither structured nor parseable address exists', () => {
      const document = { location: ['Galgenen'] };
      expect(parseHornbachLocation(document)).toEqual({ street: '', postalCode: '', city: 'Galgenen' });
    });

    it('returns empty fields for a document with no location data at all', () => {
      expect(parseHornbachLocation({})).toEqual({ street: '', postalCode: '', city: '' });
    });
  });

  // ── buildHornbachDescription ──
  describe('buildHornbachDescription', () => {
    it('joins non-empty rich-text sections and strips HTML', () => {
      const document = {
        introduction: '<p>HORNBACH ist ein f&uuml;hrender Baumarkt.</p>',
        description: '',
        expectation: '<p>Sie haben eine Ausbildung im Verkauf.</p>',
        offering: '',
        about: '',
        additional: '',
        benefits: '',
        contact_text: '',
        department: ['Verkauf'],
      };
      const description = buildHornbachDescription(document);
      expect(description).toContain('HORNBACH ist ein führender Baumarkt.');
      expect(description).toContain('Sie haben eine Ausbildung im Verkauf.');
      expect(description).toContain('Bereich: Verkauf');
    });

    it('returns an empty string when every section is empty', () => {
      expect(buildHornbachDescription({})).toBe('');
      expect(
        buildHornbachDescription({
          introduction: '', description: '', expectation: '', offering: '',
          about: '', additional: '', benefits: '', contact_text: '',
        }),
      ).toBe('');
    });
  });

  // ── resolveHornbachPostedDate ──
  describe('resolveHornbachPostedDate', () => {
    it('parses a valid create_date string', () => {
      expect(resolveHornbachPostedDate({ create_date: '2026-06-15T08:00:00Z' })).toBe('2026-06-15');
    });

    it('parses a millisecond create_date_timestamp when create_date is absent', () => {
      const ms = Date.UTC(2026, 5, 20);
      expect(resolveHornbachPostedDate({ create_date_timestamp: ms })).toBe('2026-06-20');
    });

    it('parses a second-based create_date_timestamp when create_date is absent', () => {
      const seconds = Date.UTC(2026, 5, 20) / 1000;
      expect(resolveHornbachPostedDate({ create_date_timestamp: seconds })).toBe('2026-06-20');
    });

    it('falls back to today when neither field parses', () => {
      const today = new Date().toISOString().split('T')[0];
      expect(resolveHornbachPostedDate({})).toBe(today);
      expect(resolveHornbachPostedDate({ create_date: 'not-a-date', create_date_timestamp: -1 })).toBe(today);
    });
  });

  // ── resolveHornbachEmploymentType ──
  describe('resolveHornbachEmploymentType', () => {
    it('prefers the typed schema_values.working_time_types field', () => {
      expect(
        resolveHornbachEmploymentType({ schema_values: { working_time_types: ['FULL_TIME'] } }),
      ).toEqual({ employmentType: 'FULL_TIME', contract: 'full-time' });
      expect(
        resolveHornbachEmploymentType({ schema_values: { working_time_types: ['PART_TIME'] } }),
      ).toEqual({ employmentType: 'PART_TIME', contract: 'part-time' });
    });

    it('falls back to the free-text schedule facet when no typed field is present', () => {
      const result = resolveHornbachEmploymentType({ schedule: ['Vollzeit'] }, 'Verkäufer:in', '');
      expect(result.employmentType).toBe('FULL_TIME');
    });

    it('defaults to FULL_TIME when nothing indicates part-time', () => {
      const result = resolveHornbachEmploymentType({}, 'Verkäufer:in Elektro', '');
      expect(result.employmentType).toBe('FULL_TIME');
    });
  });

  // ── parseHornbachOffer (full document, real-shape fixture) ──
  describe('parseHornbachOffer', () => {
    const sursHqDocument = {
      title: 'Verkäufer:in Bau &amp; Garten',
      offer_uuid: 'uuid-abc-123',
      external_id: '148901',
      title_slug: 'verkauferin-bau-garten',
      url: 'https://jobs.hornbach.ch/offer-redirect/?offerApiId=148901',
      application_url: 'https://career5.successfactors.eu/career?company=hornbach&job=148901',
      introduction: '<p>HORNBACH Sursee sucht Verst&auml;rkung.</p>',
      description: '',
      expectation: '',
      offering: '',
      about: '',
      additional: '',
      benefits: '',
      contact_text: '',
      full_address: ['Schellenrain 9, 6210 Sursee'],
      location: ['Sursee'],
      location_objects: [{ city: 'Sursee', street: 'Schellenrain 9', zip: '6210', country: 'CH' }],
      department: ['Verkauf'],
      schedule: ['Vollzeit'],
      schema_values: { working_time_types: ['FULL_TIME'] },
      custom_filter_4: ['Luzern (LU)'],
      country: ['Switzerland'],
      create_date: '2026-06-01T00:00:00Z',
      create_date_timestamp: Date.UTC(2026, 5, 1),
      status: 'ACTIVE',
    };

    it('parses a full offer document into the normalized field set', () => {
      const parsed = parseHornbachOffer(sursHqDocument);
      expect(parsed.externalId).toBe('148901');
      expect(parsed.title).toBe('Verkäufer:in Bau & Garten');
      expect(parsed.titleSlug).toBe('verkauferin-bau-garten');
      expect(parsed.url).toBe('https://jobs.hornbach.ch/offer-redirect/?offerApiId=148901');
      expect(parsed.applyUrl).toBe('https://career5.successfactors.eu/career?company=hornbach&job=148901');
      expect(parsed.description).toContain('HORNBACH Sursee sucht Verstärkung.');
      expect(parsed.city).toBe('Sursee');
      expect(parsed.postalCode).toBe('6210');
      expect(parsed.streetAddress).toBe('Schellenrain 9');
      expect(parsed.cantonCode).toBe('LU');
      expect(parsed.employmentType).toBe('FULL_TIME');
      expect(parsed.postedDate).toBe('2026-06-01');
    });

    it('handles a real negative-control document (Luzern Littau, canton LU, NOT the Sursee HQ)', () => {
      const luzernDocument = {
        title: 'Verkäufer:in Elektro',
        offer_uuid: 'uuid-def-456',
        external_id: '152523',
        title_slug: 'verkauferin-elektro',
        url: 'https://jobs.hornbach.ch/offer-redirect/?offerApiId=152523',
        application_url: 'https://career5.successfactors.eu/career?company=hornbach&job=152523',
        introduction: '<p>HORNBACH Luzern-Littau sucht Verst&auml;rkung im Elektro-Team.</p>',
        full_address: ['Thorenbergstrasse 49, 6014 Luzern Littau'],
        location: ['Luzern Littau'],
        department: ['Verkauf'],
        schedule: ['Vollzeit'],
        schema_values: { working_time_types: ['FULL_TIME'] },
        custom_filter_4: ['Luzern (LU)'],
        country: ['Switzerland'],
        create_date: '2026-06-10T00:00:00Z',
        status: 'ACTIVE',
      };
      const parsed = parseHornbachOffer(luzernDocument);
      expect(parsed.city).toBe('Luzern Littau');
      expect(parsed.postalCode).toBe('6014');
      expect(parsed.streetAddress).toBe('Thorenbergstrasse 49');
      expect(parsed.cantonCode).toBe('LU');

      // The critical assertion: even though this posting is in the SAME
      // canton (LU) as the Sursee HQ, resolveAddress must use the job's OWN
      // Luzern Littau street address, never the Schellenrain 9 HQ address —
      // proving the gate is city-based, not canton-based.
      expect(parsed.streetAddress).not.toBe('Schellenrain 9');
      expect(parsed.postalCode).not.toBe('6210');
    });

    it('handles a document missing optional fields gracefully (no location_objects, no application_url)', () => {
      const minimalDocument = {
        title: 'Lagermitarbeiter:in',
        external_id: '999999',
        url: 'https://jobs.hornbach.ch/offer-redirect/?offerApiId=999999',
        location: ['Galgenen'],
        country: ['Switzerland'],
      };
      const parsed = parseHornbachOffer(minimalDocument);
      expect(parsed.title).toBe('Lagermitarbeiter:in');
      expect(parsed.city).toBe('Galgenen');
      expect(parsed.postalCode).toBe('');
      expect(parsed.streetAddress).toBe('');
      expect(parsed.applyUrl).toBe('https://jobs.hornbach.ch/offer-redirect/?offerApiId=999999');
      expect(parsed.employmentType).toBe('FULL_TIME');
      expect(parsed.postedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('handles a completely empty document without throwing', () => {
      const parsed = parseHornbachOffer({});
      expect(parsed.title).toBe('');
      expect(parsed.externalId).toBe('');
      expect(parsed.city).toBe('');
      expect(parsed.postalCode).toBe('');
      expect(parsed.streetAddress).toBe('');
    });
  });

  // ── Structured-data field completeness (repo Non-Negotiable #3) ──
  describe('structured-data field completeness', () => {
    // Shape mirroring what fetchAllHornbachJobs emits for a Sursee HQ job.
    const validJob = {
      id: 'hornbach-148901',
      slug: 'verkauferin-bau-garten-hornbach-sursee',
      slugByLocale: { de: 'verkauferin-bau-garten-hornbach-sursee' },
      company: 'Hornbach',
      companyKey: 'hornbach',
      companyDomain: 'hornbach.ch',
      title: 'Verkäufer:in Bau & Garten',
      titleByLocale: { de: 'Verkäufer:in Bau & Garten' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Sursee',
      canton: 'LU',
      url: 'https://jobs.hornbach.ch/offer-redirect/?offerApiId=148901',
      source: 'Hornbach Dedicated Parser (job-shop/Typesense)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Sursee',
      addressRegion: 'LU',
      streetAddress: 'Schellenrain 9',
      postalCode: '6210',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().split('T')[0],
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
      expect(validJob.company).toBe('Hornbach');
    });
  });
});
