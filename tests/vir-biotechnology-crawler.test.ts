/**
 * Vir Biotechnology (Humabs BioMed) crawler parser tests
 *
 * Tests parseGreenhouseJobs(), isSwissLocation(), inferCanton(), and parseCity()
 * using mock Greenhouse API responses.
 */
import { describe, it, expect } from 'vitest';
import {
  parseGreenhouseJobs,
  isSwissLocation,
  inferCanton,
  parseCity,
  htmlToText,
  slugify,
  normalizeSpace,
} from '@/scripts/lib/vir-biotechnology-job-parser.mjs';

// ─── Mock Greenhouse API response ─────────────────────────────────────────────

const MOCK_GREENHOUSE_RESPONSE = {
  jobs: [
    {
      id: 100001,
      title: 'Senior Scientist, Antibody Discovery',
      absolute_url: 'https://job-boards.greenhouse.io/virbiotechnologyinc/jobs/100001',
      location: { name: 'Bellinzona, Switzerland' },
      offices: [{ name: 'Bellinzona, Switzerland', id: 1 }],
      departments: [{ name: 'Research' }],
      content: '<p>We are seeking a Senior Scientist to join our antibody discovery team in Bellinzona. The ideal candidate has deep expertise in monoclonal antibody engineering and immune repertoire analysis.</p>',
      first_published: '2026-03-01T10:00:00Z',
      updated_at: '2026-03-15T14:30:00Z',
    },
    {
      id: 100002,
      title: 'Research Associate, Virology',
      absolute_url: 'https://job-boards.greenhouse.io/virbiotechnologyinc/jobs/100002',
      location: { name: 'Bellinzona, Switzerland' },
      offices: [{ name: 'Bellinzona, Switzerland', id: 1 }],
      departments: [{ name: 'Research' }],
      content: '<p>Join our virology research team at the Bellinzona R&D center. The Research Associate will support viral characterization studies and contribute to our infectious disease programs.</p>',
      first_published: '2026-02-20T09:00:00Z',
      updated_at: '2026-03-10T11:00:00Z',
    },
    {
      id: 100003,
      title: 'Vice President, Business Development',
      absolute_url: 'https://job-boards.greenhouse.io/virbiotechnologyinc/jobs/100003',
      location: { name: 'San Francisco, California, United States' },
      offices: [{ name: 'San Francisco, CA', id: 2 }],
      departments: [{ name: 'Commercial' }],
      content: '<p>Lead business development strategy for Vir Biotechnology from our San Francisco headquarters.</p>',
      first_published: '2026-03-10T08:00:00Z',
      updated_at: '2026-03-20T16:00:00Z',
    },
    {
      id: 100004,
      title: 'Lab Technician',
      absolute_url: 'https://job-boards.greenhouse.io/virbiotechnologyinc/jobs/100004',
      location: { name: 'Lugano, Switzerland' },
      offices: [{ name: 'Lugano, Switzerland', id: 3 }],
      departments: [{ name: 'Operations' }],
      content: '<p>Support laboratory operations at our Swiss facility in Lugano. Maintain equipment and assist with experimental protocols.</p>',
      first_published: '2026-03-05T07:00:00Z',
      updated_at: '2026-03-18T10:00:00Z',
    },
  ],
};

const MOCK_EMPTY_RESPONSE = { jobs: [] };
const MOCK_NO_SWISS = {
  jobs: [
    {
      id: 200001,
      title: 'Data Analyst',
      absolute_url: 'https://job-boards.greenhouse.io/virbiotechnologyinc/jobs/200001',
      location: { name: 'San Francisco, California, United States' },
      offices: [{ name: 'San Francisco, CA', id: 2 }],
      departments: [{ name: 'Data' }],
      content: '<p>Analyze clinical trial data.</p>',
      first_published: '2026-03-01T08:00:00Z',
    },
  ],
};

// ─── parseGreenhouseJobs tests ────────────────────────────────────────────────

describe('parseGreenhouseJobs — Swiss location filtering', () => {
  it('filters only Swiss jobs from mixed response', () => {
    const jobs = parseGreenhouseJobs(MOCK_GREENHOUSE_RESPONSE);
    expect(jobs).toHaveLength(3); // Bellinzona x2 + Lugano x1
  });

  it('excludes San Francisco jobs', () => {
    const jobs = parseGreenhouseJobs(MOCK_GREENHOUSE_RESPONSE);
    const sfJobs = jobs.filter((j) => j.location.includes('San Francisco'));
    expect(sfJobs).toHaveLength(0);
  });

  it('extracts correct titles', () => {
    const jobs = parseGreenhouseJobs(MOCK_GREENHOUSE_RESPONSE);
    const titles = jobs.map((j) => j.title);
    expect(titles).toContain('Senior Scientist, Antibody Discovery');
    expect(titles).toContain('Research Associate, Virology');
    expect(titles).toContain('Lab Technician');
  });

  it('extracts correct city from location', () => {
    const jobs = parseGreenhouseJobs(MOCK_GREENHOUSE_RESPONSE);
    const cities = jobs.map((j) => j.city);
    expect(cities).toContain('Bellinzona');
    expect(cities).toContain('Lugano');
  });

  it('sets canton to TI for Bellinzona and Lugano', () => {
    const jobs = parseGreenhouseJobs(MOCK_GREENHOUSE_RESPONSE);
    for (const job of jobs) {
      expect(job.canton).toBe('TI');
    }
  });

  it('extracts datePosted from first_published', () => {
    const jobs = parseGreenhouseJobs(MOCK_GREENHOUSE_RESPONSE);
    expect(jobs[0].datePosted).toBe('2026-03-01');
  });

  it('extracts department', () => {
    const jobs = parseGreenhouseJobs(MOCK_GREENHOUSE_RESPONSE);
    expect(jobs[0].department).toBe('Research');
  });

  it('returns empty for empty response', () => {
    expect(parseGreenhouseJobs(MOCK_EMPTY_RESPONSE)).toHaveLength(0);
  });

  it('returns empty when no Swiss jobs', () => {
    expect(parseGreenhouseJobs(MOCK_NO_SWISS)).toHaveLength(0);
  });

  it('handles null/undefined input', () => {
    expect(parseGreenhouseJobs(null as any)).toHaveLength(0);
    expect(parseGreenhouseJobs(undefined as any)).toHaveLength(0);
  });
});

// ─── isSwissLocation tests ────────────────────────────────────────────────────

describe('isSwissLocation', () => {
  it('returns true for Bellinzona', () => {
    expect(isSwissLocation('Bellinzona, Switzerland')).toBe(true);
  });

  it('returns true for Lugano', () => {
    expect(isSwissLocation('Lugano, Switzerland')).toBe(true);
  });

  it('returns false for San Francisco', () => {
    expect(isSwissLocation('San Francisco, California, United States')).toBe(false);
  });

  it('is case insensitive', () => {
    expect(isSwissLocation('BELLINZONA, SWITZERLAND')).toBe(true);
  });
});

// ─── inferCanton tests ────────────────────────────────────────────────────────

describe('inferCanton', () => {
  it('returns TI for Bellinzona', () => { expect(inferCanton('Bellinzona')).toBe('TI'); });
  it('returns TI for Lugano', () => { expect(inferCanton('Lugano')).toBe('TI'); });
  it('returns ZH for Zurich', () => { expect(inferCanton('Zurich')).toBe('ZH'); });
  it('returns empty for unknown', () => { expect(inferCanton('Tokyo')).toBe(''); });
});

// ─── parseCity tests ──────────────────────────────────────────────────────────

describe('parseCity', () => {
  it('extracts city from "City, Country"', () => {
    expect(parseCity('Bellinzona, Switzerland')).toBe('Bellinzona');
  });

  it('extracts city from "City, State, Country"', () => {
    expect(parseCity('San Francisco, California, United States')).toBe('San Francisco');
  });
});
