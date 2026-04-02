/**
 * Tests for the Otis SA (Workday) crawler parser.
 *
 * Tests parseOtisWorkdayListings(), parseOtisWorkdayDetail(),
 * isSwissLocation(), and utility functions using mock Workday API responses.
 */
import { describe, it, expect } from 'vitest';
import {
  parseOtisWorkdayListings,
  parseOtisWorkdayDetail,
  isSwissLocation,
  parseWorkdayCity,
  buildPublicUrl,
  inferEmploymentType,
  slugify,
  normalizeSpace,
  stripHtml,
} from '@/scripts/lib/otis-job-parser.mjs';

// ─── Mock Workday API listing response ────────────────────────────────────────

const MOCK_LISTINGS = {
  jobPostings: [
    {
      title: 'Field Technician - Ticino',
      externalPath: '/job/CHE---Ticino/Field-Technician_REQ20001',
      locationsText: 'CHE - Ticino',
      bulletFields: ['REQ20001', 'Full time'],
      postedOn: '2026-03-10',
    },
    {
      title: 'Service Supervisor',
      externalPath: '/job/CHE---Lugano/Service-Supervisor_REQ20002',
      locationsText: 'CHE - Lugano',
      bulletFields: ['REQ20002', 'Full time'],
      postedOn: '2026-03-12',
    },
    {
      title: 'Elevator Engineer',
      externalPath: '/job/DEU---Berlin/Elevator-Engineer_REQ20003',
      locationsText: 'DEU - Berlin',
      bulletFields: ['REQ20003', 'Full time'],
      postedOn: '2026-03-08',
    },
    {
      title: 'Sales Representative',
      externalPath: '/job/FRA---Paris/Sales-Rep_REQ20004',
      locationsText: 'FRA - Paris',
      bulletFields: ['REQ20004', 'Full time'],
      postedOn: '2026-03-05',
    },
    {
      title: 'Maintenance Technician',
      externalPath: '/job/CHE---Switzerland/Maintenance-Tech_REQ20005',
      locationsText: 'Switzerland',
      bulletFields: ['REQ20005', 'Part time'],
      postedOn: '2026-03-14',
    },
  ],
  total: 5,
};

// ─── Mock Workday job detail ──────────────────────────────────────────────────

const MOCK_DETAIL = {
  jobPostingInfo: {
    title: 'Field Technician - Ticino',
    location: 'CHE - Ticino',
    jobDescription: '<p>Otis SA cerca un tecnico di campo per la manutenzione e riparazione di ascensori nella regione Ticino.</p><ul><li>Manutenzione preventiva degli impianti</li><li>Diagnosi e riparazione guasti</li><li>Assistenza clienti on-site</li></ul><p>Offriamo un ambiente dinamico e formazione continua nel settore degli ascensori.</p>',
    timeType: 'Full time',
    jobReqId: 'REQ20001',
    startDate: '2026-04-01',
    country: { descriptor: 'Switzerland' },
  },
};

// ─── parseOtisWorkdayListings tests ───────────────────────────────────────────

describe('parseOtisWorkdayListings — Swiss filtering', () => {
  it('filters only Swiss listings', () => {
    const results = parseOtisWorkdayListings(MOCK_LISTINGS);
    expect(results).toHaveLength(3); // Ticino + Lugano + Switzerland
  });

  it('excludes Berlin and Paris listings', () => {
    const results = parseOtisWorkdayListings(MOCK_LISTINGS);
    const locations = results.map((r) => r.location);
    expect(locations.every((l) => !l.includes('Berlin') && !l.includes('Paris'))).toBe(true);
  });

  it('extracts correct titles', () => {
    const results = parseOtisWorkdayListings(MOCK_LISTINGS);
    const titles = results.map((r) => r.title);
    expect(titles).toContain('Field Technician - Ticino');
    expect(titles).toContain('Service Supervisor');
    expect(titles).toContain('Maintenance Technician');
  });

  it('extracts city from location text', () => {
    const results = parseOtisWorkdayListings(MOCK_LISTINGS);
    const luganoJob = results.find((r) => r.title === 'Service Supervisor');
    expect(luganoJob?.city).toBe('Lugano');
  });

  it('deduplicates by externalPath', () => {
    const duped = {
      jobPostings: [
        ...MOCK_LISTINGS.jobPostings,
        MOCK_LISTINGS.jobPostings[0], // duplicate
      ],
    };
    const results = parseOtisWorkdayListings(duped);
    expect(results).toHaveLength(3);
  });

  it('returns empty for null/undefined', () => {
    expect(parseOtisWorkdayListings(null as any)).toHaveLength(0);
    expect(parseOtisWorkdayListings(undefined as any)).toHaveLength(0);
  });

  it('returns empty for empty postings', () => {
    expect(parseOtisWorkdayListings({ jobPostings: [] })).toHaveLength(0);
  });
});

// ─── parseOtisWorkdayDetail tests ─────────────────────────────────────────────

describe('parseOtisWorkdayDetail', () => {
  it('extracts title', () => {
    const result = parseOtisWorkdayDetail(MOCK_DETAIL, '/job/test');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Field Technician - Ticino');
  });

  it('extracts description without HTML', () => {
    const result = parseOtisWorkdayDetail(MOCK_DETAIL, '/job/test');
    expect(result!.description).not.toMatch(/<[a-z]/i);
    expect(result!.description).toContain('tecnico di campo');
    expect(result!.description).toContain('ascensori');
  });

  it('builds correct public URL', () => {
    const result = parseOtisWorkdayDetail(MOCK_DETAIL, '/job/CHE---Ticino/Field-Tech_REQ20001');
    expect(result!.url).toContain('otis.wd5.myworkdayjobs.com');
    expect(result!.url).toContain('/job/CHE---Ticino/Field-Tech_REQ20001');
  });

  it('extracts datePosted from startDate', () => {
    const result = parseOtisWorkdayDetail(MOCK_DETAIL, '/job/test');
    expect(result!.datePosted).toBe('2026-04-01');
  });

  it('detects FULL_TIME employment type', () => {
    const result = parseOtisWorkdayDetail(MOCK_DETAIL, '/job/test');
    expect(result!.employmentType).toBe('FULL_TIME');
  });

  it('returns null for null input', () => {
    expect(parseOtisWorkdayDetail(null, '/job/test')).toBeNull();
  });

  it('returns null for empty title', () => {
    const noTitle = { jobPostingInfo: { title: '', jobDescription: 'text' } };
    expect(parseOtisWorkdayDetail(noTitle, '/job/test')).toBeNull();
  });
});

// ─── isSwissLocation tests ────────────────────────────────────────────────────

describe('isSwissLocation', () => {
  it('returns true for Ticino', () => { expect(isSwissLocation('CHE - Ticino')).toBe(true); });
  it('returns true for Lugano', () => { expect(isSwissLocation('CHE - Lugano')).toBe(true); });
  it('returns true for Switzerland', () => { expect(isSwissLocation('Switzerland')).toBe(true); });
  it('returns false for Berlin', () => { expect(isSwissLocation('DEU - Berlin')).toBe(false); });
  it('returns false for Paris', () => { expect(isSwissLocation('FRA - Paris')).toBe(false); });
});

// ─── Utility function tests ───────────────────────────────────────────────────

describe('parseWorkdayCity', () => {
  it('extracts city from "CHE - Ticino"', () => { expect(parseWorkdayCity('CHE - Ticino')).toBe('Ticino'); });
  it('extracts city from "CHE - Lugano"', () => { expect(parseWorkdayCity('CHE - Lugano')).toBe('Lugano'); });
  it('handles "Lugano, Switzerland"', () => { expect(parseWorkdayCity('Lugano, Switzerland')).toBe('Lugano'); });
});

describe('buildPublicUrl', () => {
  it('builds correct URL', () => {
    expect(buildPublicUrl('/job/CHE---Ticino/Field-Tech_REQ20001')).toBe(
      'https://otis.wd5.myworkdayjobs.com/en-US/REC_Ext_Gateway/job/CHE---Ticino/Field-Tech_REQ20001'
    );
  });
});

describe('Otis — slugify', () => {
  it('generates correct slug', () => {
    expect(slugify('Field Technician - Ticino')).toBe('field-technician-ticino');
  });

  it('handles accented characters', () => {
    expect(slugify('Técnico de Campo Zürich')).toBe('tecnico-de-campo-zurich');
  });

  it('truncates long slugs to 180 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(180);
  });
});

describe('Otis — stripHtml', () => {
  it('removes HTML tags', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).not.toMatch(/<[a-z]/i);
  });

  it('decodes HTML entities', () => {
    expect(stripHtml('AT&amp;T')).toContain('AT&T');
  });

  it('returns empty string for empty input', () => {
    expect(stripHtml('')).toBe('');
  });
});

describe('Otis — inferEmploymentType', () => {
  it('detects FULL_TIME from Full time', () => {
    expect(inferEmploymentType('', '', 'Full time')).toBe('FULL_TIME');
  });

  it('detects PART_TIME from Part time', () => {
    expect(inferEmploymentType('', '', 'Part time')).toBe('PART_TIME');
  });

  it('detects PART_TIME from 60%', () => {
    expect(inferEmploymentType('Technician 60%')).toBe('PART_TIME');
  });

  it('defaults to FULL_TIME', () => {
    expect(inferEmploymentType('Field Technician')).toBe('FULL_TIME');
  });
});
