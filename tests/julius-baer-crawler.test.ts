/**
 * Julius Baer crawler parser tests
 *
 * Tests parseWorkdayListings(), parseWorkdayJobDetail(),
 * isTicinoLocation(), and utility functions using mock Workday API responses.
 */
import { describe, it, expect } from 'vitest';
import {
  parseWorkdayListings,
  parseWorkdayJobDetail,
  isTicinoLocation,
  parseWorkdayCity,
  buildPublicUrl,
  detectCategory,
  detectExperienceLevel,
  detectEmploymentType,
  slugify,
  normalizeSpace,
  stripHtml,
} from '@/scripts/lib/julius-baer-job-parser.mjs';

// ─── Mock Workday API listing response ────────────────────────────────────────

const MOCK_LISTINGS = {
  jobPostings: [
    {
      title: 'Relationship Manager - Lugano',
      externalPath: '/job/CHE---Lugano/Relationship-Manager_REQ12345',
      locationsText: 'CHE - Lugano',
      bulletFields: ['REQ12345', 'Full time'],
    },
    {
      title: 'Senior Compliance Officer',
      externalPath: '/job/CHE---Lugano/Senior-Compliance-Officer_REQ12346',
      locationsText: 'CHE - Lugano',
      bulletFields: ['REQ12346', 'Full time'],
    },
    {
      title: 'Software Engineer',
      externalPath: '/job/CHE---Zurich/Software-Engineer_REQ12347',
      locationsText: 'CHE - Zurich',
      bulletFields: ['REQ12347', 'Full time'],
    },
    {
      title: 'Portfolio Manager',
      externalPath: '/job/SGP---Singapore/Portfolio-Manager_REQ12348',
      locationsText: 'SGP - Singapore',
      bulletFields: ['REQ12348', 'Full time'],
    },
    {
      title: 'Private Banking Advisor - Ticino',
      externalPath: '/job/CHE---Lugano/Private-Banking-Advisor_REQ12349',
      locationsText: 'CHE - Lugano',
      bulletFields: ['REQ12349', 'Full time'],
    },
  ],
  total: 5,
};

// ─── Mock Workday job detail ──────────────────────────────────────────────────

const MOCK_DETAIL = {
  jobPostingInfo: {
    title: 'Relationship Manager - Lugano',
    location: 'CHE - Lugano',
    jobDescription: '<p>Join Julius Baer as a Relationship Manager in our Lugano office. You will manage a portfolio of high-net-worth clients and provide tailored wealth management solutions.</p><ul><li>Manage client relationships</li><li>Portfolio advisory</li><li>Risk assessment</li></ul>',
    timeType: 'Full time',
    jobReqId: 'REQ12345',
    startDate: '2026-03-15',
    country: { descriptor: 'Switzerland' },
  },
};

// ─── parseWorkdayListings tests ───────────────────────────────────────────────

describe('parseWorkdayListings — Ticino filtering', () => {
  it('filters only Lugano/Ticino listings', () => {
    // Cathedral 2026-05-10: TARGET_CANTONS expanded to all 26 CH cantons.
    // Zurich (ZH) is now a target, so count goes from 3 (Lugano only) to 4
    // (3 Lugano + 1 Zurich). Singapore (SGP) is still excluded.
    const results = parseWorkdayListings(MOCK_LISTINGS);
    expect(results).toHaveLength(4); // 3 Lugano + 1 Zurich
  });

  it('excludes Zurich and Singapore listings', () => {
    // Cathedral 2026-05-10: Zurich is now a target — it is included.
    // Only non-CH locations (SGP - Singapore) are excluded.
    const results = parseWorkdayListings(MOCK_LISTINGS);
    const locations = results.map((r) => r.location);
    expect(locations.some((l) => l.includes('Zurich'))).toBe(true);
    expect(locations.some((l) => l.includes('Singapore'))).toBe(false);
  });

  it('extracts correct titles', () => {
    const results = parseWorkdayListings(MOCK_LISTINGS);
    const titles = results.map((r) => r.title);
    expect(titles).toContain('Relationship Manager - Lugano');
    expect(titles).toContain('Senior Compliance Officer');
    expect(titles).toContain('Private Banking Advisor - Ticino');
  });

  it('extracts city from location text', () => {
    const results = parseWorkdayListings(MOCK_LISTINGS);
    expect(results[0].city).toBe('Lugano');
  });

  it('deduplicates by externalPath', () => {
    const duped = {
      jobPostings: [
        ...MOCK_LISTINGS.jobPostings,
        MOCK_LISTINGS.jobPostings[0], // duplicate
      ],
    };
    // Cathedral 2026-05-10: 4 unique (3 Lugano + 1 Zurich), dedup still works.
    const results = parseWorkdayListings(duped);
    expect(results).toHaveLength(4);
  });

  it('returns empty for null/undefined', () => {
    expect(parseWorkdayListings(null as any)).toHaveLength(0);
    expect(parseWorkdayListings(undefined as any)).toHaveLength(0);
  });

  it('returns empty for empty postings', () => {
    expect(parseWorkdayListings({ jobPostings: [] })).toHaveLength(0);
  });
});

// ─── parseWorkdayJobDetail tests ──────────────────────────────────────────────

describe('parseWorkdayJobDetail', () => {
  it('extracts title', () => {
    const result = parseWorkdayJobDetail(MOCK_DETAIL, '/job/test');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Relationship Manager - Lugano');
  });

  it('extracts description without HTML', () => {
    const result = parseWorkdayJobDetail(MOCK_DETAIL, '/job/test');
    expect(result!.description).not.toMatch(/<[a-z]/i);
    expect(result!.description).toContain('Relationship Manager');
  });

  it('builds correct public URL', () => {
    const result = parseWorkdayJobDetail(MOCK_DETAIL, '/job/CHE---Lugano/RM_REQ12345');
    expect(result!.url).toContain('juliusbaer.wd3.myworkdayjobs.com');
    expect(result!.url).toContain('/job/CHE---Lugano/RM_REQ12345');
  });

  it('extracts datePosted from startDate', () => {
    const result = parseWorkdayJobDetail(MOCK_DETAIL, '/job/test');
    expect(result!.datePosted).toBe('2026-03-15');
  });

  it('returns null for null input', () => {
    expect(parseWorkdayJobDetail(null, '/job/test')).toBeNull();
  });
});

// ─── isTicinoLocation tests ───────────────────────────────────────────────────

describe('isTicinoLocation', () => {
  it('returns true for Lugano', () => { expect(isTicinoLocation('CHE - Lugano')).toBe(true); });
  it('returns true for lugano lowercase', () => { expect(isTicinoLocation('lugano')).toBe(true); });
  // Cathedral 2026-05-10: Zurich (ZH) is now a target canton — returns true.
  it('returns false for Zurich', () => { expect(isTicinoLocation('CHE - Zurich')).toBe(true); });
  it('returns false for Singapore', () => { expect(isTicinoLocation('SGP - Singapore')).toBe(false); });
});

// ─── Utility function tests ───────────────────────────────────────────────────

describe('parseWorkdayCity', () => {
  it('extracts city from "CHE - Lugano"', () => { expect(parseWorkdayCity('CHE - Lugano')).toBe('Lugano'); });
  it('extracts city from "Lugano, Switzerland"', () => { expect(parseWorkdayCity('Lugano, Switzerland')).toBe('Lugano'); });
});

describe('detectCategory', () => {
  it('detects wealth management', () => { expect(detectCategory('Relationship Manager')).toBe('wealth-management'); });
  it('detects technology', () => { expect(detectCategory('Software Engineer')).toBe('technology'); });
  it('detects risk', () => { expect(detectCategory('Compliance Officer')).toBe('risk'); });
});

describe('detectExperienceLevel', () => {
  it('detects SENIOR for Senior title', () => { expect(detectExperienceLevel('Senior Compliance Officer')).toBe('SENIOR'); });
  it('detects ENTRY for Junior title', () => { expect(detectExperienceLevel('Junior Analyst')).toBe('ENTRY'); });
  it('defaults to MID', () => { expect(detectExperienceLevel('Compliance Officer')).toBe('MID'); });
});

describe('detectEmploymentType', () => {
  it('detects FULL_TIME', () => { expect(detectEmploymentType('Full time')).toBe('FULL_TIME'); });
  it('detects PART_TIME', () => { expect(detectEmploymentType('Part time')).toBe('PART_TIME'); });
  it('defaults to FULL_TIME', () => { expect(detectEmploymentType('')).toBe('FULL_TIME'); });
});
