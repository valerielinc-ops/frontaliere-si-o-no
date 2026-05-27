/**
 * Interroll Group — TYPO3 careers page parser tests
 */
import { describe, it, expect } from 'vitest';

import {
  parseListingPage,
  parseDetailPage,
  isSwissLocation,
  slugify,
  detectCategory,
  detectExperienceLevel,
  MIN_DESC_LENGTH,
} from '@/scripts/lib/interroll-job-parser.mjs';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const FIXTURE_LISTING_PAGE = `
<!DOCTYPE html>
<html>
<head><title>Interroll - Job offers</title></head>
<body>
<main>
  <h1>Global job offers</h1>
  <div class="job-listing-item">
    <img src="/icons/engineering.svg" alt="Engineering">
    <h3>Mechanical Design Engineer</h3>
    <p>Sant'Antonino, Switzerland | R&D | asap</p>
    <a href="/company/careers/jobs/job-detail/mechanical-design-engineer-santantonino">Details</a>
  </div>
  <div class="job-listing-item">
    <img src="/icons/production.svg" alt="Production">
    <h3>Production Planner</h3>
    <p>Sant'Antonino, Switzerland | Production | asap</p>
    <a href="/company/careers/jobs/job-detail/production-planner-santantonino">Details</a>
  </div>
  <div class="job-listing-item">
    <img src="/icons/sales.svg" alt="Sales">
    <h3>Area Sales Manager Products</h3>
    <p>Sinsheim, Germany | Sales | asap</p>
    <a href="/company/careers/jobs/job-detail/area-sales-manager-products-sinsheim">Details</a>
  </div>
  <div class="job-listing-item">
    <img src="/icons/it.svg" alt="IT">
    <h3>Senior Software Developer</h3>
    <p>Sant'Antonino, Switzerland | IT | asap</p>
    <a href="/company/careers/jobs/job-detail/senior-software-developer-santantonino">Details</a>
  </div>
</main>
</body>
</html>
`;

const FIXTURE_DETAIL_PAGE = `
<!DOCTYPE html>
<html>
<head><title>Mechanical Design Engineer - Interroll</title></head>
<body>
<main>
  <h1>Mechanical Design Engineer</h1>
  <div class="job-detail-content">
    <p>Interroll Group is looking for a <strong>Mechanical Design Engineer</strong> to join our R&D team in Sant'Antonino, Ticino, Switzerland. You will be responsible for designing innovative conveyor and sorter solutions.</p>
    <p><strong>Your Tasks:</strong></p>
    <ul>
      <li>Design and develop mechanical components and assemblies for material handling solutions.</li>
      <li>Create 3D CAD models and detailed engineering drawings using SolidWorks or Creo.</li>
      <li>Perform FEA simulations and stress analyses to validate designs.</li>
      <li>Collaborate with manufacturing, quality, and project management teams.</li>
      <li>Prepare technical documentation including BOM, specifications, and test protocols.</li>
    </ul>
    <p><strong>Your Profile:</strong></p>
    <ul>
      <li>BSc/MSc in Mechanical Engineering or equivalent.</li>
      <li>3-5 years experience in mechanical design, preferably in automation or material handling.</li>
      <li>Proficiency in 3D CAD software (SolidWorks, Creo, or similar).</li>
      <li>Experience with FEA tools and simulation.</li>
      <li>Fluent in English and Italian; German is a plus.</li>
    </ul>
  </div>
</main>
</body>
</html>
`;

// ─── parseListingPage tests ─────────────────────────────────────────────────

describe('parseListingPage', () => {
  it('finds four jobs in the fixture', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs).toHaveLength(4);
  });

  it('extracts correct titles', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs[0].title).toBe('Mechanical Design Engineer');
    expect(jobs[1].title).toBe('Production Planner');
  });

  it('builds absolute URLs from relative paths', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs[0].url).toContain('interroll.com');
    expect(jobs[0].url).toContain('job-detail/mechanical-design-engineer');
  });

  it('extracts location from surrounding text', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs[0].location).toContain('Switzerland');
  });

  it('returns empty array for empty input', () => {
    expect(parseListingPage('')).toHaveLength(0);
  });

  it('does not include duplicate URLs', () => {
    const doubledHtml = FIXTURE_LISTING_PAGE + FIXTURE_LISTING_PAGE;
    const jobs = parseListingPage(doubledHtml);
    const urls = jobs.map(j => j.url);
    const unique = new Set(urls);
    expect(urls.length).toBe(unique.size);
  });
});

// ─── isSwissLocation tests ──────────────────────────────────────────────────

describe('isSwissLocation', () => {
  it('matches Switzerland', () => {
    expect(isSwissLocation("Sant'Antonino, Switzerland")).toBe(true);
  });

  it('matches Ticino', () => {
    expect(isSwissLocation('Ticino')).toBe(true);
  });

  it('does not match Germany', () => {
    expect(isSwissLocation('Sinsheim, Germany')).toBe(false);
  });
});

// ─── parseDetailPage tests ──────────────────────────────────────────────────

describe('parseDetailPage', () => {
  it('extracts the title', () => {
    const result = parseDetailPage(FIXTURE_DETAIL_PAGE);
    expect(result.title).toBe('Mechanical Design Engineer');
  });

  it('extracts the description body', () => {
    const result = parseDetailPage(FIXTURE_DETAIL_PAGE);
    expect(result.body).toContain('Mechanical Design Engineer');
    expect(result.body).toContain('SolidWorks');
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

describe('detectCategory', () => {
  it('detects engineering for engineer', () => {
    expect(detectCategory('Mechanical Design Engineer')).toBe('engineering');
  });

  it('detects production for Production Planner', () => {
    expect(detectCategory('Production Planner')).toBe('production');
  });

  it('detects sales for Area Sales Manager', () => {
    expect(detectCategory('Area Sales Manager')).toBe('sales');
  });

  it('detects engineering for Software Developer (engineer pattern)', () => {
    expect(detectCategory('Senior Software Developer')).toBe('engineering');
  });

  it('detects technology for IT Administrator', () => {
    expect(detectCategory('IT Administrator')).toBe('technology');
  });
});

describe('detectExperienceLevel', () => {
  it('detects SENIOR for Senior title', () => {
    expect(detectExperienceLevel('Senior Software Developer')).toBe('SENIOR');
  });

  it('detects ENTRY for Apprentice', () => {
    expect(detectExperienceLevel('Apprentice Logistics')).toBe('ENTRY');
  });

  it('detects MID for regular title', () => {
    expect(detectExperienceLevel('Production Planner')).toBe('MID');
  });
});
