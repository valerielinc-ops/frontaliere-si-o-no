/**
 * Casale SA — Recruitee API parser tests
 */
import { describe, it, expect } from 'vitest';

import {
  parseApiResponse,
  buildJobFromApi,
  combineDescriptionSections,
  isCasaleSwissOffer,
  parseListingPage,
  slugify,
  detectCategory,
  detectExperienceLevel,
  MIN_DESC_LENGTH,
} from '@/scripts/lib/casale-job-parser.mjs';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const FIXTURE_API_RESPONSE = {
  offers: [
    {
      id: 101,
      slug: 'senior-process-engineer-1',
      title: 'Senior Process Engineer',
      description: '<p>Casale SA is hiring a Senior Process Engineer for our Lugano headquarters. You will work on ammonia and methanol synthesis processes, designing innovative solutions for the fertilizer industry.</p><p><strong>Key responsibilities:</strong></p><ul><li>Process simulation and optimization using Aspen Plus and HYSYS.</li><li>Support project engineering with mass and energy balances.</li><li>Review P&IDs and technical specifications.</li><li>Participate in HAZOP studies and risk assessments.</li></ul>',
      requirements: '<p><strong>Requirements:</strong></p><ul><li>MSc in Chemical Engineering.</li><li>5+ years experience in process design.</li><li>Proficiency in process simulation tools.</li></ul>',
      country_code: 'CH',
      locations: [{ city: 'Lugano', state: 'Ticino', country: 'Switzerland', country_code: 'CH' }],
      employment_type_code: 'fulltime_permanent',
      department: 'Engineering',
      published_at: '2026-03-10T10:00:00Z',
      remote: false,
      hybrid: false,
      careers_apply_url: 'https://recruit.casale.ch/o/senior-process-engineer-1/c/new',
    },
    {
      id: 102,
      slug: 'apprenticeship-laboratory-technician',
      title: 'Apprenticeship - Laboratory Technician in Chemistry AFC',
      description: '<p>Casale SA offers an apprenticeship position for a Laboratory Technician in Chemistry (AFC) at our Lugano site.</p>',
      country_code: 'CH',
      locations: [{ city: 'Lugano', state: 'Ticino', country: 'Switzerland', country_code: 'CH' }],
      employment_type_code: 'internship',
      department: 'R&D',
      published_at: '2026-03-05T08:00:00Z',
      remote: false,
      hybrid: false,
    },
    {
      id: 103,
      slug: 'mechanical-engineer-india',
      title: 'Mechanical Engineer',
      description: '<p>Mechanical Engineer position in Mumbai office.</p>',
      country_code: 'IN',
      locations: [{ city: 'Mumbai', state: 'Maharashtra', country: 'India', country_code: 'IN' }],
      employment_type_code: 'fulltime_permanent',
      department: 'Engineering',
      published_at: '2026-03-08T10:00:00Z',
      remote: false,
      hybrid: false,
    },
  ],
};

const FIXTURE_LISTING_HTML = `
<!DOCTYPE html>
<html>
<body>
  <div class="job-list">
    <a href="/o/senior-process-engineer-1">Senior Process Engineer</a>
    <a href="/o/apprenticeship-laboratory-technician">Apprenticeship - Laboratory Technician in Chemistry AFC</a>
    <a href="/o/electrical-engineer-2">Electrical Engineer</a>
    <a href="/o/junior-technical-visual-designer">Junior Technical Visual Designer</a>
    <a href="/o/proposal-manager">Proposal Manager</a>
  </div>
</body>
</html>
`;

// ─── parseApiResponse tests ─────────────────────────────────────────────────

describe('parseApiResponse', () => {
  it('filters to Swiss offers only', () => {
    const swiss = parseApiResponse(FIXTURE_API_RESPONSE);
    expect(swiss).toHaveLength(2);
    expect(swiss.every(o => o.locations?.[0]?.country_code === 'CH')).toBe(true);
  });

  it('returns empty for empty input', () => {
    expect(parseApiResponse({})).toHaveLength(0);
  });
});

// ─── isCasaleSwissOffer tests ───────────────────────────────────────────────

describe('isCasaleSwissOffer', () => {
  it('accepts CH country_code', () => {
    expect(isCasaleSwissOffer({ country_code: 'CH' })).toBe(true);
  });

  it('accepts location with Switzerland', () => {
    expect(isCasaleSwissOffer({ location: 'Lugano, Switzerland' })).toBe(true);
  });

  it('rejects Indian offer', () => {
    expect(isCasaleSwissOffer(FIXTURE_API_RESPONSE.offers[2])).toBe(false);
  });
});

// ─── buildJobFromApi tests ──────────────────────────────────────────────────

describe('buildJobFromApi', () => {
  it('builds a job with correct title', () => {
    const job = buildJobFromApi(FIXTURE_API_RESPONSE.offers[0]);
    expect(job.title).toBe('Senior Process Engineer');
  });

  it('builds correct location', () => {
    const job = buildJobFromApi(FIXTURE_API_RESPONSE.offers[0]);
    expect(job.city).toBe('Lugano');
    expect(job.location).toContain('Lugano');
  });

  it('builds correct detail URL', () => {
    const job = buildJobFromApi(FIXTURE_API_RESPONSE.offers[0]);
    expect(job.detailUrl).toContain('recruit.casale.ch');
    expect(job.detailUrl).toContain('senior-process-engineer');
  });

  it('extracts date posted', () => {
    const job = buildJobFromApi(FIXTURE_API_RESPONSE.offers[0]);
    expect(job.datePosted).toBe('2026-03-10');
  });

  it('sets INTERNSHIP employment type for apprenticeship', () => {
    const job = buildJobFromApi(FIXTURE_API_RESPONSE.offers[1]);
    expect(job.employmentType).toBe('INTERNSHIP');
  });
});

// ─── combineDescriptionSections tests ───────────────────────────────────────

describe('combineDescriptionSections', () => {
  it('combines description and requirements', () => {
    const combined = combineDescriptionSections(FIXTURE_API_RESPONSE.offers[0]);
    expect(combined).toContain('Senior Process Engineer');
    expect(combined).toContain('MSc in Chemical Engineering');
  });

  it('returns empty for empty offer', () => {
    expect(combineDescriptionSections({})).toBe('');
  });
});

// ─── parseListingPage tests ─────────────────────────────────────────────────

describe('parseListingPage', () => {
  it('finds five jobs from HTML listing', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_HTML);
    expect(jobs).toHaveLength(5);
  });

  it('extracts correct slugs', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_HTML);
    expect(jobs[0].slug).toBe('senior-process-engineer-1');
  });

  it('returns empty for empty input', () => {
    expect(parseListingPage('')).toHaveLength(0);
  });
});

// ─── Utility tests ──────────────────────────────────────────────────────────

describe('detectCategory', () => {
  it('detects engineering for Process Engineer', () => {
    expect(detectCategory('Senior Process Engineer')).toBe('engineering');
  });

  it('detects internship for Apprenticeship', () => {
    expect(detectCategory('Apprenticeship - Laboratory Technician')).toBe('internship');
  });

  it('detects sales for Proposal Manager', () => {
    expect(detectCategory('Proposal Manager')).toBe('sales');
  });
});

describe('detectExperienceLevel', () => {
  it('detects SENIOR for Senior Process Engineer', () => {
    expect(detectExperienceLevel('Senior Process Engineer')).toBe('SENIOR');
  });

  it('detects ENTRY for Apprenticeship', () => {
    expect(detectExperienceLevel('Apprenticeship - Laboratory Technician')).toBe('ENTRY');
  });

  it('detects MID for Electrical Engineer', () => {
    expect(detectExperienceLevel('Electrical Engineer')).toBe('MID');
  });
});
