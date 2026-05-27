/**
 * Helsinn Healthcare SA — AITI e-lavoro platform parser tests
 */
import { describe, it, expect } from 'vitest';

import {
  parseListingPage,
  parseDetailPage,
  slugify,
  detectCategory,
  detectExperienceLevel,
  MIN_DESC_LENGTH,
} from '@/scripts/lib/helsinn-job-parser.mjs';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Fixture simulating the e-lavoro.ch listing page with job announcements */
const FIXTURE_LISTING_PAGE = `
<!DOCTYPE html>
<html>
<head><title>Helsinn Healthcare SA - AITI e-lavoro</title></head>
<body>
<div id="content">
  <h1>I nostri annunci</h1>
  <div class="views-row">
    <a href="/node/1234">Clinical Research Associate</a>
    <span class="location">Lugano, Ticino</span>
  </div>
  <div class="views-row">
    <a href="/node/1235">Regulatory Affairs Manager</a>
    <span class="location">Pambio Noranco, Ticino</span>
  </div>
  <div class="views-row">
    <a href="/node/1236">Senior Medical Science Liaison</a>
    <span class="location">Lugano, Switzerland</span>
  </div>
</div>
<footer>
  <a href="/node/76">Published Announcements</a>
  <a href="/node/75">Login</a>
  <a href="/cookie-policy">Cookie policy</a>
  <a href="/privacy-policy">Privacy Policy</a>
</footer>
</body>
</html>
`;

/** Fixture simulating a detail page on e-lavoro.ch */
const FIXTURE_DETAIL_PAGE = `
<!DOCTYPE html>
<html>
<head><title>Clinical Research Associate - Helsinn Healthcare SA</title></head>
<body>
<div class="node__content">
  <h1>Clinical Research Associate</h1>
  <div class="field--name-body">
    <p>Helsinn Healthcare SA is looking for a Clinical Research Associate (CRA) to join our growing team in Lugano, Ticino, Switzerland. This role involves oversight of clinical trial activities and ensures compliance with ICH-GCP guidelines and applicable regulations.</p>
    <p><strong>Key Responsibilities:</strong></p>
    <ul>
      <li>Monitor clinical trial sites to ensure compliance with the protocol, ICH-GCP, and applicable regulations.</li>
      <li>Review and evaluate clinical data for completeness, accuracy and consistency.</li>
      <li>Prepare monitoring visit reports and follow-up letters in a timely manner.</li>
      <li>Maintain essential documents and trial master file in accordance with regulatory requirements.</li>
      <li>Collaborate with cross-functional teams including medical affairs, regulatory, and pharmacovigilance.</li>
    </ul>
    <p><strong>Requirements:</strong></p>
    <ul>
      <li>Degree in Life Sciences, Pharmacy, or related field.</li>
      <li>Minimum 2 years of clinical monitoring experience in oncology preferred.</li>
      <li>Knowledge of ICH-GCP guidelines and applicable Swiss/EU regulations.</li>
      <li>Strong organizational and communication skills.</li>
      <li>Fluent in English; Italian is an advantage.</li>
    </ul>
  </div>
</div>
</body>
</html>
`;

/** Fixture: e-lavoro page with no job offers */
const FIXTURE_EMPTY_LISTING = `
<!DOCTYPE html>
<html>
<head><title>Helsinn Healthcare SA - AITI e-lavoro</title></head>
<body>
<div id="content">
  <h1>I nostri annunci</h1>
  <p>Purtroppo non ci sono offerte di lavoro, torna a trovarci!</p>
</div>
<footer>
  <a href="/node/76">Published Announcements</a>
  <a href="/node/75">Login</a>
</footer>
</body>
</html>
`;

// ─── parseListingPage tests ─────────────────────────────────────────────────

describe('parseListingPage', () => {
  it('finds three jobs in the fixture', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs).toHaveLength(3);
  });

  it('extracts correct titles', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs[0].title).toBe('Clinical Research Associate');
    expect(jobs[1].title).toBe('Regulatory Affairs Manager');
    expect(jobs[2].title).toBe('Senior Medical Science Liaison');
  });

  it('extracts node IDs from URLs', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs[0].id).toBe('1234');
    expect(jobs[1].id).toBe('1235');
  });

  it('builds absolute URLs with e-lavoro.ch base', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs[0].url).toContain('e-lavoro.ch');
    expect(jobs[0].url).toContain('/node/1234');
  });

  it('skips navigation links (node/75, node/76, cookie-policy, etc.)', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    const ids = jobs.map((j) => j.id);
    expect(ids).not.toContain('75');
    expect(ids).not.toContain('76');
    // No jobs should have "cookie" or "privacy" titles
    for (const job of jobs) {
      expect(job.title.toLowerCase()).not.toContain('cookie');
      expect(job.title.toLowerCase()).not.toContain('privacy');
      expect(job.title.toLowerCase()).not.toContain('login');
    }
  });

  it('returns empty array for "no jobs" message', () => {
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
    expect(result.title).toBe('Clinical Research Associate');
  });

  it('extracts the description body', () => {
    const result = parseDetailPage(FIXTURE_DETAIL_PAGE);
    expect(result.body).toContain('Clinical Research Associate');
    expect(result.body).toContain('ICH-GCP');
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
    expect(slugify('Clinical Research Associate', 'helsinn')).toBe('clinical-research-associate-helsinn');
  });

  it('handles special characters', () => {
    expect(slugify('Responsabile QA/QC')).toContain('responsabile');
  });
});

describe('detectCategory', () => {
  it('detects pharma for Regulatory Affairs', () => {
    expect(detectCategory('Regulatory Affairs Manager')).toBe('pharma');
  });

  it('detects science for research roles', () => {
    expect(detectCategory('Senior Scientist')).toBe('science');
  });

  it('detects quality for QA roles', () => {
    expect(detectCategory('Quality Assurance Specialist')).toBe('quality');
  });
});

describe('detectExperienceLevel', () => {
  it('detects SENIOR for Senior title', () => {
    expect(detectExperienceLevel('Senior Medical Science Liaison')).toBe('SENIOR');
  });

  it('detects ENTRY for intern', () => {
    expect(detectExperienceLevel('Intern Clinical Research')).toBe('ENTRY');
  });

  it('detects MID for regular title', () => {
    expect(detectExperienceLevel('Clinical Research Associate')).toBe('MID');
  });
});
