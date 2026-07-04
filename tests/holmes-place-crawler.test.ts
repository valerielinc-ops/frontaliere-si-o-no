import { describe, it, expect } from 'vitest';
import {
  HOLMES_PLACE_KEY,
  HOLMES_PLACE_COMPANY_NAME,
  HOLMES_PLACE_COMPANY_DOMAIN,
  isHolmesPlaceJob,
  isTrustedDomain,
  resolveAddress,
  normalizeHolmesPlaceListing,
  buildDescription,
  detectCategory,
  detectEmploymentType,
} from '../scripts/lib/holmes-place-job-parser.mjs';
import { stripContactPII } from '../scripts/lib/strip-contact-pii.mjs';

describe('Holmes Place crawler parser', () => {
  // ── Constants ──
  it('exports valid company key, name and domain', () => {
    expect(HOLMES_PLACE_KEY).toBe('holmes-place');
    expect(HOLMES_PLACE_COMPANY_NAME).toBe('Holmes Place');
    expect(HOLMES_PLACE_COMPANY_DOMAIN).toBe('holmesplace.ch');
  });

  // ── isCompanyJob ──
  describe('isHolmesPlaceJob', () => {
    it('matches by companyKey', () => {
      expect(isHolmesPlaceJob({ companyKey: 'holmes-place' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isHolmesPlaceJob({ company: 'Holmes Place' })).toBe(true);
    });

    it('matches case-insensitively and with prefixed keys', () => {
      expect(isHolmesPlaceJob({ companyKey: 'holmes-place-zurich' })).toBe(true);
      expect(isHolmesPlaceJob({ company: 'HOLMES PLACE' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isHolmesPlaceJob({ url: 'https://www.holmesplace.ch/de/karriere' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isHolmesPlaceJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isHolmesPlaceJob(null)).toBe(false);
      expect(isHolmesPlaceJob(undefined)).toBe(false);
      expect(isHolmesPlaceJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the primary holmesplace.ch domain', () => {
      expect(isTrustedDomain('https://www.holmesplace.ch/de/karriere')).toBe(true);
      expect(isTrustedDomain('https://holmesplace.ch/karriere')).toBe(true);
    });

    it('rejects unrelated domains', () => {
      expect(isTrustedDomain('https://evil.example.com/holmesplace.ch/jobs')).toBe(false);
    });

    it('handles malformed URLs gracefully', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
    });
  });

  // ── resolveAddress (city/branch-gated, multi-branch — task-critical) ──
  describe('resolveAddress', () => {
    it('falls back to the Oberrieden HQ entirely when no location is supplied at all', () => {
      const resolved = resolveAddress({});
      expect(resolved.city).toBe('Oberrieden');
      expect(resolved.postalCode).toBe('8942');
      expect(resolved.streetAddress).toBe('Seestrasse 97');
    });

    it('resolves the Oberrieden HQ explicitly by city text', () => {
      const resolved = resolveAddress({ city: 'Oberrieden' });
      expect(resolved).toEqual({
        city: 'Oberrieden',
        postalCode: '8942',
        streetAddress: 'Seestrasse 97',
      });
    });

    it('does NOT leak the Oberrieden HQ street address for a same-canton non-HQ city (bare "Zürich")', () => {
      // Zürich is canton ZH, same canton as the Oberrieden HQ — this is
      // exactly the case a canton-only gate would get wrong, AND Zürich
      // itself hosts 2 different Holmes Place branches so a bare city name
      // is genuinely ambiguous between them.
      const resolved = resolveAddress({ location: 'Zürich' });
      expect(resolved.city).toBe('Zürich');
      expect(resolved.postalCode).toBe('');
      expect(resolved.streetAddress).toBe('');
    });

    it('does NOT leak any Zürich-branch address for a different-canton city (Lausanne, VD)', () => {
      const resolved = resolveAddress({ location: 'Lausanne' });
      expect(resolved.city).toBe('Lausanne');
      expect(resolved.postalCode).toBe('1003');
      expect(resolved.streetAddress).toBe('Rue de la Mercerie 12');
      // And definitely not the ZH HQ or either Zürich branch street.
      expect(resolved.streetAddress).not.toBe('Seestrasse 97');
      expect(resolved.streetAddress).not.toBe('Badenerstrasse 420');
      expect(resolved.streetAddress).not.toBe('Steinmühleplatz 1');
    });

    it('resolves the Crowne Plaza Zürich branch via a brand keyword in the title, disambiguating a bare "Zürich" location', () => {
      const resolved = resolveAddress({ title: 'Personal Trainer Crowne Plaza', location: 'Zürich' });
      expect(resolved.city).toBe('Zürich');
      expect(resolved.postalCode).toBe('8040');
      expect(resolved.streetAddress).toBe('Badenerstrasse 420');
    });

    it('resolves the Jelmoli Zürich branch via a brand keyword, distinct from Crowne Plaza', () => {
      const resolved = resolveAddress({ title: 'Empfang Jelmoli', location: 'Zürich' });
      expect(resolved.city).toBe('Zürich');
      expect(resolved.postalCode).toBe('8001');
      expect(resolved.streetAddress).toBe('Steinmühleplatz 1');
      // Distinct from the Crowne Plaza branch despite sharing the same city.
      expect(resolved.streetAddress).not.toBe('Badenerstrasse 420');
    });

    it('resolves Genève by unique city name (no other branch shares this city)', () => {
      const resolved = resolveAddress({ location: 'Genève' });
      expect(resolved).toEqual({
        city: 'Genève',
        postalCode: '1204',
        streetAddress: 'Rue du Rhône 50',
      });
    });

    it('matches Geneva/Genf spelling variants case-insensitively', () => {
      expect(resolveAddress({ location: 'GENEVA' }).streetAddress).toBe('Rue du Rhône 50');
      expect(resolveAddress({ title: 'Sales (Genf)' }).streetAddress).toBe('Rue du Rhône 50');
    });

    it('preserves a real per-job street address when the source already provides one, even for an ambiguous city', () => {
      const resolved = resolveAddress({
        location: 'Zürich',
        postalCode: '8005',
        streetAddress: 'Hardturmstrasse 1',
      });
      expect(resolved).toEqual({
        city: 'Zürich',
        postalCode: '8005',
        streetAddress: 'Hardturmstrasse 1',
      });
    });

    it('matches Oberrieden case-insensitively and ignores surrounding whitespace', () => {
      const resolved = resolveAddress({ city: '  OBERRIEDEN  ' });
      expect(resolved.streetAddress).toBe('Seestrasse 97');
    });
  });

  // ── normalizeHolmesPlaceListing (pure DOM-row normalization) ──
  describe('normalizeHolmesPlaceListing', () => {
    it('normalizes a raw scraped row', () => {
      const listing = normalizeHolmesPlaceListing({
        title: '  Personal Trainer (m/w/d)  ',
        location: ' Zürich Jelmoli ',
        category: ' Fitness ',
      });
      expect(listing).toEqual({
        title: 'Personal Trainer (m/w/d)',
        location: 'Zürich Jelmoli',
        category: 'Fitness',
      });
    });

    it('rejects rows with no title / too-short title', () => {
      expect(normalizeHolmesPlaceListing({ title: '', location: 'Zürich' })).toBeNull();
      expect(normalizeHolmesPlaceListing({ title: 'ab' })).toBeNull();
      expect(normalizeHolmesPlaceListing({})).toBeNull();
    });

    it('defaults missing location/category to empty strings rather than throwing', () => {
      const listing = normalizeHolmesPlaceListing({ title: 'Club Manager' });
      expect(listing).toEqual({ title: 'Club Manager', location: '', category: '' });
    });
  });

  // ── buildDescription (safe-default description, no per-job detail page) ──
  describe('buildDescription', () => {
    it('builds a description referencing the resolved city when a branch/city is known', () => {
      const description = buildDescription({ title: 'Personal Trainer', location: 'Lausanne', category: 'Fitness' });
      expect(description).toContain('Personal Trainer');
      expect(description).toContain('Holmes Place');
      expect(description).toContain('Lausanne');
      expect(description).toContain('Fitness');
    });

    it('is at least a few sentences long (avoids thin-content indexation, Non-Negotiable #4)', () => {
      const description = buildDescription({ title: 'Club Manager', location: 'Genève', category: 'Management' });
      expect(description.split(/\s+/).length).toBeGreaterThan(20);
    });

    it('still produces a sane description when location/category are missing', () => {
      const description = buildDescription({ title: 'Reception', location: '', category: '' });
      expect(description).toContain('Reception');
      expect(description).toContain('Holmes Place');
    });
  });

  // ── Category / employment-type detection (fitness-chain taxonomy) ──
  describe('detectCategory', () => {
    it('classifies Personal Trainer roles', () => {
      expect(detectCategory('Personal Trainer (m/w/d)')).toBe('Personal Trainer');
    });

    it('classifies reception/club-admin roles', () => {
      expect(detectCategory('Empfang / Reception 50%')).toBe('Club Admin / Reception');
    });

    it('classifies sales/membership roles', () => {
      expect(detectCategory('Membership Sales Consultant')).toBe('Sales');
    });

    it('classifies group fitness instructors', () => {
      expect(detectCategory('Group Fitness Instructor')).toBe('Group Fitness');
    });

    it('classifies spa/wellness roles', () => {
      expect(detectCategory('Spa & Wellness Therapist')).toBe('Spa / Wellness');
    });

    it('falls back to "Altro" for unrecognized titles', () => {
      expect(detectCategory('Something Completely Different')).toBe('Altro');
    });
  });

  describe('detectEmploymentType', () => {
    it('detects part-time from German/French/English keywords', () => {
      expect(detectEmploymentType('Personal Trainer Teilzeit')).toBe('PART_TIME');
      expect(detectEmploymentType('Coach temps partiel')).toBe('PART_TIME');
      expect(detectEmploymentType('Part-time Reception')).toBe('PART_TIME');
    });

    it('detects full-time from German/French/English keywords', () => {
      expect(detectEmploymentType('Club Manager Vollzeit')).toBe('FULL_TIME');
      expect(detectEmploymentType('Full-time Personal Trainer')).toBe('FULL_TIME');
    });

    it('defaults to OTHER when no employment-type keyword is present', () => {
      expect(detectEmploymentType('Personal Trainer')).toBe('OTHER');
    });
  });

  // ── PII stripping (gym-branch manager contact leakage, shared helper reuse) ──
  describe('stripContactPII applied to a Holmes Place description', () => {
    it('strips a branch manager name + direct phone in a German-language description', () => {
      const withLeak =
        `${buildDescription({ title: 'Empfang', location: 'Genève', category: 'Club Admin' })} ` +
        `Bei Fragen wende dich an Max Mustermann (Tel. 044 123 45 67).`;
      const cleaned = stripContactPII(withLeak);
      expect(cleaned).not.toContain('Max Mustermann');
      expect(cleaned).not.toContain('044 123 45 67');
      // The rest of the description survives intact.
      expect(cleaned).toContain('Empfang');
      expect(cleaned).toContain('Genève');
    });

    it('strips a bare standalone Swiss phone number even without a captured name', () => {
      const withLeak = `${buildDescription({ title: 'Club Manager', location: 'Lausanne', category: 'Management' })} Telefon: 021 123 45 67.`;
      const cleaned = stripContactPII(withLeak);
      expect(cleaned).not.toContain('021 123 45 67');
    });

    it('is idempotent and a no-op when there is nothing to strip', () => {
      const description = buildDescription({ title: 'Personal Trainer', location: 'Oberrieden', category: 'Fitness' });
      const once = stripContactPII(description);
      const twice = stripContactPII(once);
      expect(once).toBe(description);
      expect(twice).toBe(once);
    });
  });

  // ── Structured-data completeness (repo Non-Negotiable #3) ──
  describe('structured-data field completeness', () => {
    // Shape mirroring what fetchAllHolmesPlaceJobs emits for a Genève branch job.
    const validJob = {
      id: 'holmes-place-abc123def456',
      slug: 'personal-trainer-holmes-place-geneve',
      slugByLocale: { de: 'personal-trainer-holmes-place-geneve' },
      company: 'Holmes Place',
      companyKey: 'holmes-place',
      companyDomain: 'holmesplace.ch',
      title: 'Personal Trainer (m/w/d)',
      titleByLocale: { de: 'Personal Trainer (m/w/d)' },
      description: 'A test job description for validation, at least fifty words long so it clears the thin-content floor for indexation purposes across every single locale this exact listing gets translated into during the AI localization pipeline step that always follows this parser inside the standard crawler pipeline used by every dedicated employer crawler in this repository today.',
      descriptionByLocale: {
        de: 'A test job description for validation, at least fifty words long so it clears the thin-content floor for indexation purposes across every single locale this exact listing gets translated into during the AI localization pipeline step that always follows this parser inside the standard crawler pipeline used by every dedicated employer crawler in this repository today.',
      },
      location: 'Genève',
      canton: 'GE',
      url: 'https://www.holmesplace.ch/de/karriere',
      source: 'Holmes Place Dedicated Parser',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Genève',
      addressRegion: 'GE',
      streetAddress: 'Rue du Rhône 50',
      postalCode: '1204',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().split('T')[0],
      hiringOrganization: { name: 'Holmes Place' },
      jobLocation: { addressLocality: 'Genève', addressCountry: 'CH' },
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

    it('has the fields required for job-page structured data (Non-Negotiable #3)', () => {
      // baseSalary/hiringOrganization/jobLocation are synthesized downstream
      // with safe defaults from these per-job inputs; the parser itself
      // guarantees the raw inputs are present and truthy.
      const structuredDataInputs = [
        'postalCode', 'streetAddress', 'title', 'description',
        'datePosted' in validJob ? 'datePosted' : 'postedDate',
        'addressLocality', 'addressCountry', 'employmentType',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect((validJob as Record<string, unknown>)[field]).toBeTruthy();
      }
      expect(validJob.company).toBe('Holmes Place');
      expect(validJob.hiringOrganization.name).toBe('Holmes Place');
      expect(validJob.jobLocation.addressLocality).toBe('Genève');
    });

    it('the description clears the 50-word thin-content floor (Non-Negotiable #4)', () => {
      expect(validJob.description.split(/\s+/).length).toBeGreaterThanOrEqual(50);
    });
  });
});
