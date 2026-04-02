/**
 * Tests for the Unilabs (Workable) crawler parser.
 *
 * Tests parseUnilabsListings(), parseUnilabsJobDetail(),
 * isSwissJob(), and utility functions using mock Workable API responses.
 */
import { describe, it, expect } from 'vitest';
import {
  parseUnilabsListings,
  parseUnilabsJobDetail,
  isSwissJob,
  buildPublicUrl,
  parseBullets,
  inferEmploymentType,
  slugify,
  stripHtml,
} from '@/scripts/lib/unilabs-job-parser.mjs';

// ─── Mock Workable API listing response ───────────────────────────────────────

const MOCK_LISTINGS = {
  jobs: [
    {
      title: 'Laboratory Technician',
      shortcode: 'LAB001',
      city: 'Manno',
      state: 'Ticino',
      country: 'Switzerland',
      department: 'Laboratory',
      url: 'https://apply.workable.com/unilabs/j/LAB001/',
    },
    {
      title: 'Biomedical Scientist',
      shortcode: 'BIO002',
      city: 'Manno',
      state: 'Ticino',
      country: 'Switzerland',
      department: 'Research',
      url: 'https://apply.workable.com/unilabs/j/BIO002/',
    },
    {
      title: 'Medical Receptionist',
      shortcode: 'REC003',
      city: 'Milano',
      state: 'Lombardia',
      country: 'Italy',
      department: 'Administration',
      url: 'https://apply.workable.com/unilabs/j/REC003/',
    },
    {
      title: 'Quality Manager',
      shortcode: 'QM004',
      city: 'Paris',
      state: 'Île-de-France',
      country: 'France',
      department: 'Quality',
      url: 'https://apply.workable.com/unilabs/j/QM004/',
    },
  ],
};

// ─── Mock Workable job detail ─────────────────────────────────────────────────

const MOCK_DETAIL = {
  title: 'Laboratory Technician',
  description: '<p>Unilabs cerca un Tecnico di Laboratorio per il nostro centro diagnostico di Manno, Canton Ticino.</p><p>Il candidato ideale avrà esperienza in analisi cliniche e diagnostica di laboratorio.</p>',
  requirements: '<ul><li>Diploma in tecniche di laboratorio biomedico</li><li>Minimo 2 anni di esperienza in laboratorio clinico</li><li>Conoscenza della lingua italiana</li></ul>',
  benefits: '<ul><li>Formazione continua</li><li>Ambiente internazionale</li></ul>',
  type: 'Full-time',
  location: {
    city: 'Manno',
    region: 'Ticino',
    countryCode: 'CH',
    display: 'Manno, Ticino, Switzerland',
  },
  department: ['Laboratory'],
  published: '2026-03-15T00:00:00.000Z',
};

// ─── parseUnilabsListings tests ───────────────────────────────────────────────

describe('parseUnilabsListings — Swiss filtering', () => {
  it('filters only Swiss jobs', () => {
    const results = parseUnilabsListings(MOCK_LISTINGS);
    expect(results).toHaveLength(2); // Manno jobs only
  });

  it('excludes Italy and France jobs', () => {
    const results = parseUnilabsListings(MOCK_LISTINGS);
    const titles = results.map((r) => r.title);
    expect(titles).not.toContain('Medical Receptionist');
    expect(titles).not.toContain('Quality Manager');
  });

  it('extracts correct titles', () => {
    const results = parseUnilabsListings(MOCK_LISTINGS);
    const titles = results.map((r) => r.title);
    expect(titles).toContain('Laboratory Technician');
    expect(titles).toContain('Biomedical Scientist');
  });

  it('extracts city', () => {
    const results = parseUnilabsListings(MOCK_LISTINGS);
    expect(results[0].city).toBe('Manno');
  });

  it('builds correct public URL', () => {
    const results = parseUnilabsListings(MOCK_LISTINGS);
    expect(results[0].url).toBe('https://apply.workable.com/unilabs/j/LAB001/');
  });

  it('deduplicates by shortcode', () => {
    const duped = {
      jobs: [
        ...MOCK_LISTINGS.jobs,
        MOCK_LISTINGS.jobs[0], // duplicate
      ],
    };
    const results = parseUnilabsListings(duped);
    expect(results).toHaveLength(2);
  });

  it('returns empty for null/undefined', () => {
    expect(parseUnilabsListings(null as any)).toHaveLength(0);
    expect(parseUnilabsListings(undefined as any)).toHaveLength(0);
  });

  it('returns empty for empty jobs array', () => {
    expect(parseUnilabsListings({ jobs: [] })).toHaveLength(0);
  });
});

// ─── parseUnilabsJobDetail tests ──────────────────────────────────────────────

describe('parseUnilabsJobDetail', () => {
  it('extracts title', () => {
    const result = parseUnilabsJobDetail(MOCK_DETAIL);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Laboratory Technician');
  });

  it('extracts description without HTML', () => {
    const result = parseUnilabsJobDetail(MOCK_DETAIL);
    expect(result!.description).not.toMatch(/<[a-z]/i);
    expect(result!.description).toContain('Tecnico di Laboratorio');
  });

  it('includes requirements section', () => {
    const result = parseUnilabsJobDetail(MOCK_DETAIL);
    expect(result!.description).toContain('## Requirements');
    expect(result!.requirements).toContain('Conoscenza della lingua italiana');
  });

  it('includes benefits section', () => {
    const result = parseUnilabsJobDetail(MOCK_DETAIL);
    expect(result!.description).toContain('## Benefits');
    expect(result!.benefits).toContain('Formazione continua');
  });

  it('extracts city from location', () => {
    const result = parseUnilabsJobDetail(MOCK_DETAIL);
    expect(result!.city).toBe('Manno');
  });

  it('extracts published date', () => {
    const result = parseUnilabsJobDetail(MOCK_DETAIL);
    expect(result!.publishedDate).toBe('2026-03-15');
  });

  it('detects FULL_TIME employment type', () => {
    const result = parseUnilabsJobDetail(MOCK_DETAIL);
    expect(result!.employmentType).toBe('FULL_TIME');
  });

  it('returns null for null input', () => {
    expect(parseUnilabsJobDetail(null as any)).toBeNull();
  });

  it('returns null for empty title', () => {
    const noTitle = { title: '', description: 'text' };
    expect(parseUnilabsJobDetail(noTitle as any)).toBeNull();
  });
});

// ─── isSwissJob tests ─────────────────────────────────────────────────────────

describe('isSwissJob', () => {
  it('returns true for Switzerland country', () => {
    expect(isSwissJob({ country: 'Switzerland', city: 'Manno' })).toBe(true);
  });

  it('returns true for Ticino city/state', () => {
    expect(isSwissJob({ country: '', city: 'Lugano', state: 'Ticino' })).toBe(true);
  });

  it('returns false for Italy', () => {
    expect(isSwissJob({ country: 'Italy', city: 'Milano' })).toBe(false);
  });

  it('returns false for France', () => {
    expect(isSwissJob({ country: 'France', city: 'Paris' })).toBe(false);
  });
});

// ─── Utility function tests ───────────────────────────────────────────────────

describe('buildPublicUrl', () => {
  it('builds correct Workable URL', () => {
    expect(buildPublicUrl('LAB001')).toBe('https://apply.workable.com/unilabs/j/LAB001/');
  });

  it('returns empty for empty shortcode', () => {
    expect(buildPublicUrl('')).toBe('');
  });
});

describe('parseBullets', () => {
  it('extracts list items from HTML', () => {
    const html = '<ul><li>First requirement</li><li>Second requirement</li></ul>';
    const bullets = parseBullets(html);
    expect(bullets).toEqual(['First requirement', 'Second requirement']);
  });

  it('filters short items', () => {
    const html = '<ul><li>OK item here</li><li>No</li></ul>';
    const bullets = parseBullets(html);
    expect(bullets).toHaveLength(1);
  });
});

describe('Unilabs — slugify', () => {
  it('generates correct slug', () => {
    expect(slugify('Laboratory Technician Manno')).toBe('laboratory-technician-manno');
  });

  it('handles accented characters', () => {
    expect(slugify('Técnico de Laboratório Zürich')).toBe('tecnico-de-laboratorio-zurich');
  });

  it('truncates long slugs to 180 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(180);
  });
});

describe('Unilabs — stripHtml', () => {
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

describe('Unilabs — inferEmploymentType', () => {
  it('detects FULL_TIME from Full-time type', () => {
    expect(inferEmploymentType('', '', 'Full-time')).toBe('FULL_TIME');
  });

  it('detects PART_TIME from Part-time type', () => {
    expect(inferEmploymentType('', '', 'Part-time')).toBe('PART_TIME');
  });

  it('detects PART_TIME from 50%', () => {
    expect(inferEmploymentType('Technician 50%')).toBe('PART_TIME');
  });

  it('defaults to FULL_TIME', () => {
    expect(inferEmploymentType('Laboratory Technician')).toBe('FULL_TIME');
  });
});
