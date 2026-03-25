/**
 * Helsinn Healthcare SA — jobopportunity.ch parser tests
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

const FIXTURE_LISTING_PAGE = `
<!DOCTYPE html>
<html>
<head><title>Helsinn Healthcare SA - Offerte di lavoro</title></head>
<body>
<div id="content">
  <h1>Offerte di lavoro</h1>
  <table class="job-listing">
    <tr>
      <td><a href="index.php?module=profile_mod&submod=jobs&func=detail&id=1234">Clinical Research Associate</a></td>
      <td>Lugano, Ticino</td>
      <td>2026-03-20</td>
    </tr>
    <tr>
      <td><a href="index.php?module=profile_mod&submod=jobs&func=detail&id=1235">Regulatory Affairs Manager</a></td>
      <td>Pambio Noranco, Ticino</td>
      <td>2026-03-18</td>
    </tr>
    <tr>
      <td><a href="index.php?module=profile_mod&submod=jobs&func=detail&id=1236">Senior Medical Science Liaison</a></td>
      <td>Lugano, Switzerland</td>
      <td>2026-03-15</td>
    </tr>
  </table>
</div>
</body>
</html>
`;

const FIXTURE_DETAIL_PAGE = `
<!DOCTYPE html>
<html>
<head><title>Clinical Research Associate - Helsinn Healthcare SA</title></head>
<body>
<div class="job-detail">
  <h1>Clinical Research Associate</h1>
  <div class="job-description">
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

const FIXTURE_EMPTY_LISTING = `
<!DOCTYPE html>
<html>
<head><title>Helsinn - Nessuna offerta</title></head>
<body>
<div id="content">
  <h1>Offerte di lavoro</h1>
  <p>Nessuna offerta di lavoro al momento.</p>
</div>
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

  it('extracts job IDs from URLs', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs[0].id).toBe('1234');
    expect(jobs[1].id).toBe('1235');
  });

  it('builds absolute URLs', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs[0].url).toContain('helsinn.jobopportunity.ch');
    expect(jobs[0].url).toContain('id=1234');
  });

  it('returns empty array for empty listing', () => {
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
