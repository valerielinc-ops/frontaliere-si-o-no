/**
 * Mikron Group crawler parser tests
 *
 * Tests parseMikronJobs(), parseMikronJobDetail(), isSwissLocation(),
 * and utility functions using HTML fixtures.
 */
import { describe, it, expect } from 'vitest';
import {
  parseMikronJobs,
  parseMikronJobDetail,
  isSwissLocation,
  htmlToText,
  slugify,
  normalizeSpace,
} from '@/scripts/lib/mikron-job-parser.mjs';

// ─── Fixture: Drupal Views job listing ────────────────────────────────────────

const FIXTURE_AGNO_JOBS = `
<html><body>
<div class="view-open-jobs">
  <div class="views-row job-listing">
    <h3><a href="/en/group/our-people/join-us/jobs/apprendisti">Apprendisti (m/f/d)</a></h3>
    <div class="field--division">Machining</div>
    <div class="field--function">Other</div>
    <div class="field--location">Switzerland, Agno</div>
  </div>
  <div class="views-row job-listing">
    <h3><a href="/en/group/our-people/join-us/jobs/cnc-operator">CNC Operator</a></h3>
    <div class="field--division">Machining</div>
    <div class="field--function">Manufacturing</div>
    <div class="field--location">Switzerland, Agno</div>
  </div>
  <div class="views-row job-listing">
    <h3><a href="/en/group/our-people/join-us/jobs/motion-control-engineer">Motion Control Software Engineer</a></h3>
    <div class="field--division">Automation</div>
    <div class="field--function">Engineering</div>
    <div class="field--location">Switzerland, Boudry</div>
  </div>
</div>
</body></html>
`;

// ─── Fixture: All Boudry jobs (no Agno) ───────────────────────────────────────

const FIXTURE_NO_AGNO = `
<html><body>
<div class="view-open-jobs">
  <div class="views-row job-listing">
    <h3><a href="/en/group/our-people/join-us/jobs/sw-dev">Fullstack Software Developer</a></h3>
    <div class="field--division">Automation</div>
    <div class="field--function">Engineering</div>
    <div class="field--location">Switzerland, Boudry</div>
  </div>
</div>
</body></html>
`;

// ─── Fixture: Empty page ──────────────────────────────────────────────────────

const FIXTURE_EMPTY = `
<html><body>
<div class="view-open-jobs">
  <p>No open positions at this time.</p>
</div>
</body></html>
`;

// ─── Fixture: Job detail page ─────────────────────────────────────────────────

const FIXTURE_DETAIL = `
<html><body>
<main>
  <h1>CNC Operator</h1>
  <div class="node job-detail">
    <p>We are seeking a skilled CNC Operator for our Machining division in Agno, Switzerland. The ideal candidate has experience with multi-axis CNC machines and precision manufacturing.</p>
    <p><strong>Requirements:</strong></p>
    <ul>
      <li>Technical diploma in mechanics or equivalent</li>
      <li>3+ years CNC experience</li>
      <li>Knowledge of Fanuc/Siemens controls</li>
    </ul>
  </div>
  <div>Division: Machining</div>
  <div>Location: Switzerland, Agno</div>
</main>
</body></html>
`;

// ─── parseMikronJobs tests ────────────────────────────────────────────────────

describe('parseMikronJobs — Swiss filtering', () => {
  it('keeps all Swiss-site jobs when filterSwiss is true', () => {
    const jobs = parseMikronJobs(FIXTURE_AGNO_JOBS, { filterSwiss: true });
    expect(jobs.length).toBeGreaterThanOrEqual(3);
  });

  it('finds all jobs when filterSwiss is false', () => {
    const jobs = parseMikronJobs(FIXTURE_AGNO_JOBS, { filterSwiss: false });
    expect(jobs.length).toBeGreaterThanOrEqual(3);
  });

  it('extracts correct titles', () => {
    const jobs = parseMikronJobs(FIXTURE_AGNO_JOBS, { filterSwiss: true });
    const titles = jobs.map((j) => j.title);
    expect(titles).toContain('Apprendisti (m/f/d)');
    expect(titles).toContain('CNC Operator');
  });

  it('builds full URLs', () => {
    const jobs = parseMikronJobs(FIXTURE_AGNO_JOBS);
    for (const job of jobs) {
      expect(job.url).toMatch(/^https:\/\/www\.mikron\.com/);
    }
  });

  it('assigns sequential idx', () => {
    const jobs = parseMikronJobs(FIXTURE_AGNO_JOBS);
    expect(jobs[0].idx).toBe(1);
    expect(jobs[1].idx).toBe(2);
  });

  it('deduplicates by URL', () => {
    const duped = FIXTURE_AGNO_JOBS + FIXTURE_AGNO_JOBS;
    const jobs = parseMikronJobs(duped);
    const urls = jobs.map((j) => j.url);
    const unique = new Set(urls);
    expect(urls.length).toBe(unique.size);
  });
});

describe('parseMikronJobs — edge cases', () => {
  it('keeps Swiss jobs on a non-Agno page with filterSwiss', () => {
    const jobsFiltered = parseMikronJobs(FIXTURE_NO_AGNO, { filterSwiss: true });
    const jobsUnfiltered = parseMikronJobs(FIXTURE_NO_AGNO, { filterSwiss: false });
    // Swiss filtering must not discard a valid Swiss site.
    expect(jobsFiltered.length).toBeLessThanOrEqual(jobsUnfiltered.length);
    expect(jobsFiltered).toHaveLength(1);
  });

  it('returns empty for empty page', () => {
    const jobs = parseMikronJobs(FIXTURE_EMPTY);
    expect(jobs).toHaveLength(0);
  });

  it('returns empty for empty input', () => {
    expect(parseMikronJobs('')).toHaveLength(0);
  });

  it('handles null/undefined', () => {
    expect(parseMikronJobs(null as any)).toHaveLength(0);
    expect(parseMikronJobs(undefined as any)).toHaveLength(0);
  });
});

// ─── parseMikronJobDetail tests ───────────────────────────────────────────────

describe('parseMikronJobDetail', () => {
  it('extracts title from h1', () => {
    const result = parseMikronJobDetail(FIXTURE_DETAIL);
    expect(result.title).toBe('CNC Operator');
  });

  it('extracts description text', () => {
    const result = parseMikronJobDetail(FIXTURE_DETAIL);
    expect(result.description).toContain('CNC Operator');
    expect(result.description).toContain('multi-axis');
  });

  it('returns empty object for empty input', () => {
    const result = parseMikronJobDetail('');
    expect(result.title).toBe('');
    expect(result.description).toBe('');
  });
});

// ─── isSwissLocation tests ────────────────────────────────────────────────────

describe('isSwissLocation', () => {
  it('returns true for Switzerland, Agno', () => { expect(isSwissLocation('Switzerland, Agno')).toBe(true); });
  it('returns true for a country-only Swiss location', () => { expect(isSwissLocation('Switzerland')).toBe(true); });
  it('returns true for agno lowercase', () => { expect(isSwissLocation('agno')).toBe(true); });
  it('returns true for Ticino', () => { expect(isSwissLocation('Ticino')).toBe(true); });
  it('returns true for Boudry', () => { expect(isSwissLocation('Switzerland, Boudry')).toBe(true); });
  it('returns false for Rottweil', () => { expect(isSwissLocation('Germany, Rottweil')).toBe(false); });
});

// ─── Utility tests ────────────────────────────────────────────────────────────

describe('slugify', () => {
  it('converts to kebab-case', () => {
    expect(slugify('CNC Operator')).toBe('cnc-operator');
  });

  it('appends suffix', () => {
    expect(slugify('CNC Operator', 'mikron')).toBe('cnc-operator-mikron');
  });
});

describe('htmlToText', () => {
  it('strips tags', () => {
    expect(htmlToText('<p>Test</p>')).toBe('Test');
  });

  it('handles null', () => {
    expect(htmlToText(null as any)).toBe('');
  });
});

// ─── Detail page description richness ─────────────────────────────────────────

describe('parseMikronJobDetail — rich descriptions', () => {
  const RICH_DETAIL = `
<html><body>
<main>
  <h1>CNC Operator (100%)</h1>
  <article class="node job-detail">
    <p>We are seeking a skilled CNC Operator for our Machining division in Agno, Canton Ticino, Switzerland.
       The ideal candidate has experience with multi-axis CNC machines and precision manufacturing of high-performance
       cutting tools. You will work in a modern production facility with state-of-the-art equipment and be part of
       an international team dedicated to excellence in precision engineering.</p>
    <h2>Your Responsibilities</h2>
    <ul>
      <li>Operate and set up multi-axis CNC machines for precision manufacturing</li>
      <li>Read and interpret technical drawings and CAD/CAM programs</li>
      <li>Perform quality checks using precision measuring instruments</li>
      <li>Maintain machines and tools in optimal condition</li>
      <li>Collaborate with engineering team on process improvements</li>
    </ul>
    <h2>Your Profile</h2>
    <ul>
      <li>Technical diploma in mechanics or equivalent qualification</li>
      <li>3+ years experience with CNC machines (Fanuc/Siemens preferred)</li>
      <li>Knowledge of precision measuring tools and quality standards</li>
      <li>Team player with attention to detail</li>
      <li>Good knowledge of Italian and/or German language</li>
    </ul>
    <h2>We Offer</h2>
    <p>A positive corporate culture with strong team spirit, varied work responsibilities,
       comprehensive onboarding, and competitive compensation with excellent social benefits.</p>
  </article>
  <div>Division: Machining</div>
  <div>Location: Switzerland, Agno</div>
</main>
</body></html>`;

  it('extracts rich description from detail page with >50 words', () => {
    const result = parseMikronJobDetail(RICH_DETAIL);
    const wordCount = result.description.split(/\s+/).length;
    expect(wordCount).toBeGreaterThanOrEqual(50);
  });

  it('preserves key content from detail page', () => {
    const result = parseMikronJobDetail(RICH_DETAIL);
    expect(result.description).toContain('CNC');
    expect(result.description).toContain('precision');
    expect(result.title).toBe('CNC Operator (100%)');
  });
});
