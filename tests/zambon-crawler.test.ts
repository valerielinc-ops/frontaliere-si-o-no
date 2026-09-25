/**
 * Zambon Svizzera SA — careers page parser tests
 *
 * Tests both the new zambon.com/en/open-positions format and
 * legacy jobopportunity.ch format for backward compatibility.
 */
import { describe, it, expect } from 'vitest';

import {
  parseListingPage,
  parseDetailPage,
  slugify,
  detectCategory,
  detectExperienceLevel,
  MIN_DESC_LENGTH,
} from '@/scripts/lib/zambon-job-parser.mjs';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Fixture: Legacy jobopportunity.ch format (backward compat) */
const FIXTURE_LISTING_PAGE = `
<!DOCTYPE html>
<html>
<head><title>Zambon Svizzera SA - Offerte di lavoro</title></head>
<body>
<div id="content">
  <h1>Offerte di lavoro</h1>
  <table class="job-listing">
    <tr>
      <td><a href="index.php?module=profile_mod&submod=jobs&func=detail&id=2001">Quality Assurance Specialist</a></td>
      <td>Cadempino, Ticino</td>
      <td>2026-03-22</td>
    </tr>
    <tr>
      <td><a href="index.php?module=profile_mod&submod=jobs&func=detail&id=2002">Pharmaceutical Production Operator</a></td>
      <td>Cadempino, Switzerland</td>
      <td>2026-03-20</td>
    </tr>
    <tr>
      <td><a href="index.php?module=profile_mod&submod=jobs&func=detail&id=2003">Senior Regulatory Affairs Specialist</a></td>
      <td>Cadempino, Ticino</td>
      <td>2026-03-18</td>
    </tr>
    <tr>
      <td><a href="index.php?module=profile_mod&submod=jobs&func=detail&id=2004">Apprendista impiegato/a di commercio</a></td>
      <td>Cadempino, Svizzera</td>
      <td>2026-03-15</td>
    </tr>
  </table>
</div>
</body>
</html>
`;

/** Fixture: NcorePlat job links on zambon.com */
const FIXTURE_NCOREPLAT_LISTING = `
<!DOCTYPE html>
<html>
<head><title>Open Positions | Zambon</title></head>
<body>
<div id="content">
  <h1>Open Positions</h1>
  <div class="career-list">
    <a href="https://app.ncoreplat.com/jobposition/112500/quality-control-analyst/zambon-svizzera">Quality Control Analyst</a>
    <a href="https://app.ncoreplat.com/jobposition/112501/production-supervisor/zambon-svizzera">Production Supervisor</a>
    <a href="https://app.ncoreplat.com/jobposition/110541/autocandidatura-it/hr-italy">Autocandidatura</a>
  </div>
</div>
</body>
</html>
`;

/** Fixture: No open positions message */
const FIXTURE_EMPTY_LISTING = `
<!DOCTYPE html>
<html>
<head><title>Open Positions | Zambon</title></head>
<body>
<div id="content">
  <p>Currently there are not open positions.</p>
  <p>If you haven't found the job position that you are looking for, you can send us your resume.</p>
</div>
</body>
</html>
`;

const FIXTURE_DETAIL_PAGE = `
<!DOCTYPE html>
<html>
<head><title>Quality Assurance Specialist - Zambon Svizzera SA</title></head>
<body>
<div class="job-detail">
  <h1>Quality Assurance Specialist</h1>
  <div class="job-description">
    <p>Zambon Svizzera SA, part of the Zambon Group, is looking for a <strong>Quality Assurance Specialist</strong> to join our quality team at our Cadempino manufacturing site in Ticino, Switzerland.</p>
    <p><strong>Key Responsibilities:</strong></p>
    <ul>
      <li>Ensure compliance with GMP regulations and internal quality standards.</li>
      <li>Manage deviation investigations, CAPA implementation, and change control processes.</li>
      <li>Support internal and external audits (Swissmedic, FDA, EMA).</li>
      <li>Review and approve batch documentation and analytical results.</li>
      <li>Maintain quality management system documentation.</li>
    </ul>
    <p><strong>Requirements:</strong></p>
    <ul>
      <li>Degree in Chemistry, Pharmacy, Biology, or related field.</li>
      <li>3+ years of QA experience in a pharmaceutical manufacturing environment.</li>
      <li>Knowledge of GMP, ICH guidelines, and Swiss/EU pharmaceutical regulations.</li>
      <li>Strong analytical skills and attention to detail.</li>
      <li>Fluent in Italian and English; German is an advantage.</li>
    </ul>
  </div>
</div>
</body>
</html>
`;

// ─── parseListingPage tests — legacy format ───────────────────────────────────

describe('parseListingPage — legacy jobopportunity.ch format', () => {
  it('finds four jobs in the fixture', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs).toHaveLength(4);
  });

  it('extracts correct titles', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs[0].title).toBe('Quality Assurance Specialist');
    expect(jobs[1].title).toBe('Pharmaceutical Production Operator');
    expect(jobs[3].title).toBe('Apprendista impiegato/a di commercio');
  });

  it('extracts job IDs', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs[0].id).toBe('2001');
    expect(jobs[1].id).toBe('2002');
  });

  it('builds absolute URLs', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs[0].url).toContain('zambon.com');
    expect(jobs[0].url).toContain('id=2001');
  });
});

// ─── parseListingPage tests — NcorePlat format ───────────────────────────────

describe('parseListingPage — NcorePlat format', () => {
  it('finds two jobs (skips autocandidatura)', () => {
    const jobs = parseListingPage(FIXTURE_NCOREPLAT_LISTING);
    expect(jobs).toHaveLength(2);
  });

  it('extracts correct titles from NcorePlat links', () => {
    const jobs = parseListingPage(FIXTURE_NCOREPLAT_LISTING);
    expect(jobs[0].title).toBe('Quality Control Analyst');
    expect(jobs[1].title).toBe('Production Supervisor');
  });

  it('extracts NcorePlat job IDs', () => {
    const jobs = parseListingPage(FIXTURE_NCOREPLAT_LISTING);
    expect(jobs[0].id).toBe('112500');
    expect(jobs[1].id).toBe('112501');
  });

  it('preserves NcorePlat URLs', () => {
    const jobs = parseListingPage(FIXTURE_NCOREPLAT_LISTING);
    expect(jobs[0].url).toContain('ncoreplat.com');
  });
});

// ─── Empty/guard tests ─────────────────────────────────────────────────────

describe('parseListingPage — guards', () => {
  it('returns empty array for "no positions" message', () => {
    expect(parseListingPage(FIXTURE_EMPTY_LISTING)).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(parseListingPage('')).toHaveLength(0);
  });
});

// ─── parseDetailPage tests ──────────────────────────────────────────────────

describe('parseDetailPage', () => {
  it('extracts the title', () => {
    const result = parseDetailPage(FIXTURE_DETAIL_PAGE);
    expect(result.title).toBe('Quality Assurance Specialist');
  });

  it('extracts the description body', () => {
    const result = parseDetailPage(FIXTURE_DETAIL_PAGE);
    expect(result.body).toContain('Zambon Svizzera SA');
    expect(result.body).toContain('GMP');
  });

  it('description meets minimum length', () => {
    const result = parseDetailPage(FIXTURE_DETAIL_PAGE);
    expect(result.sourceBodyLength).toBeGreaterThanOrEqual(MIN_DESC_LENGTH);
  });

  it('returns empty for empty input', () => {
    const result = parseDetailPage('');
    expect(result.title).toBe('');
    expect(result.body).toBe('');
  });
});

// ─── Utility tests ──────────────────────────────────────────────────────────

describe('slugify', () => {
  it('creates slug from title', () => {
    expect(slugify('Quality Assurance Specialist', 'zambon')).toBe('quality-assurance-specialist-zambon');
  });

  it('handles Italian characters', () => {
    const slug = slugify('Apprendista impiegato/a di commercio');
    expect(slug).toContain('apprendista');
    expect(slug).toContain('commercio');
  });
});

describe('detectCategory', () => {
  it('detects quality for QA Specialist', () => {
    expect(detectCategory('Quality Assurance Specialist')).toBe('quality');
  });

  it('detects pharma for Regulatory Affairs', () => {
    expect(detectCategory('Senior Regulatory Affairs Specialist')).toBe('pharma');
  });

  it('detects pharma for Pharmaceutical Production Operator (pharma keyword first)', () => {
    expect(detectCategory('Pharmaceutical Production Operator')).toBe('pharma');
  });

  it('detects production for Production Operator', () => {
    expect(detectCategory('Production Operator')).toBe('production');
  });

  it('detects internship for Apprendista', () => {
    expect(detectCategory('Apprendista impiegato/a di commercio')).toBe('internship');
  });
});

describe('detectExperienceLevel', () => {
  it('detects SENIOR for Senior title', () => {
    expect(detectExperienceLevel('Senior Regulatory Affairs Specialist')).toBe('SENIOR');
  });

  it('detects ENTRY for Apprendista', () => {
    expect(detectExperienceLevel('Apprendista impiegato/a di commercio')).toBe('ENTRY');
  });

  it('detects MID for regular title', () => {
    expect(detectExperienceLevel('Quality Assurance Specialist')).toBe('MID');
  });
});
