/**
 * EMS-Chemie AG crawler parser tests
 *
 * Tests parseListingPage(), parseDetailPage(), buildJob(),
 * inferLocation(), isSwissJob().
 */
import { describe, it, expect } from 'vitest';

import {
  parseListingPage,
  parseDetailPage,
  buildJob,
  inferLocation,
  isSwissJob,
  stripHtml,
  normalizeSpace,
} from '@/scripts/lib/ems-chemie-job-parser.mjs';

// ─── Fixture: Career listing page ──────────────────────────
const LISTING_HTML = `
<html>
<body>
<main>
  <h1>Job Vacancies</h1>
  <table class="job-table">
    <tr class="job-row">
      <td><a href="/en/career/job-vacancies/chemist-rd">Chemist R&D</a></td>
      <td>Research & Development</td>
      <td>Domat/Ems</td>
    </tr>
    <tr class="job-row">
      <td><a href="/en/career/job-vacancies/production-operator">Production Operator</a></td>
      <td>Production</td>
      <td>Domat/Ems</td>
    </tr>
    <tr class="job-row">
      <td><a href="/en/career/job-vacancies/sap-consultant">SAP Consultant</a></td>
      <td>IT</td>
      <td>Domat/Ems</td>
    </tr>
  </table>
</main>
</body>
</html>`;

// ─── Fixture: Detail page ──────────────────────────────────
const DETAIL_HTML = `
<html>
<body>
<main>
  <article>
    <h1>Chemist R&amp;D</h1>
    <div class="content">
      <p>EMS-Chemie AG is the world leader in high-performance polyamides and specialty chemicals.
         We are looking for a talented Chemist for our R&D team in Domat/Ems (GR), Switzerland.
         You will work on developing new polymer formulations and improving existing products.</p>
      <h2>Your Tasks</h2>
      <ul>
        <li>Development of new high-performance polymer formulations</li>
        <li>Characterization and testing of polymer materials</li>
        <li>Collaboration with production and quality teams</li>
        <li>Documentation of research results and patent filings</li>
      </ul>
      <h2>Your Profile</h2>
      <ul>
        <li>PhD or Master's degree in Chemistry, Polymer Science, or Materials Science</li>
        <li>Experience in polymer synthesis and characterization</li>
        <li>Strong analytical and problem-solving skills</li>
        <li>Fluent in English; German is an advantage</li>
      </ul>
      <h2>We Offer</h2>
      <ul>
        <li>Innovative work environment at a market-leading company</li>
        <li>Competitive compensation and benefits package</li>
        <li>Modern R&D facilities in the Swiss Alps</li>
      </ul>
    </div>
  </article>
</main>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════════
// parseListingPage
// ═══════════════════════════════════════════════════════════════

describe('parseListingPage', () => {
  it('extracts jobs from table rows', () => {
    const jobs = parseListingPage(LISTING_HTML);
    expect(jobs.length).toBe(3);
  });

  it('extracts job titles', () => {
    const jobs = parseListingPage(LISTING_HTML);
    const titles = jobs.map((j: { title: string }) => j.title);
    expect(titles[0]).toBe('Chemist R&D');
    expect(titles[1]).toBe('Production Operator');
  });

  it('generates full URLs', () => {
    const jobs = parseListingPage(LISTING_HTML);
    expect((jobs[0] as { url: string }).url).toContain('ems-group.com');
  });

  it('returns empty array for empty input', () => {
    expect(parseListingPage('')).toHaveLength(0);
    expect(parseListingPage(null as unknown as string)).toHaveLength(0);
  });

  it('returns empty for page without listings', () => {
    expect(parseListingPage('<html><body>Nothing here</body></html>')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// parseDetailPage
// ═══════════════════════════════════════════════════════════════

describe('parseDetailPage', () => {
  it('extracts title', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('Chemist');
  });

  it('extracts profile requirements', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.requirements.length).toBeGreaterThanOrEqual(2);
    expect(result!.requirements[0]).toContain('PhD');
  });

  it('infers Domat/Ems location', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.location).toBe('Domat/Ems');
    expect(result!.canton).toBe('GR');
  });

  it('returns null for empty input', () => {
    expect(parseDetailPage('')).toBeNull();
    expect(parseDetailPage(null as unknown as string)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// inferLocation / isSwissJob
// ═══════════════════════════════════════════════════════════════

describe('inferLocation', () => {
  it('detects Domat/Ems from description', () => {
    expect(inferLocation('', 'Location: Domat/Ems, Switzerland')).toBe('Domat/Ems');
  });

  it('detects Romanshorn', () => {
    expect(inferLocation('Production Manager Romanshorn', '')).toBe('Romanshorn');
  });

  it('defaults to Domat/Ems', () => {
    expect(inferLocation('Generic Position', 'Some text')).toBe('Domat/Ems');
  });
});

describe('isSwissJob', () => {
  it('returns true for Domat/Ems', () => {
    expect(isSwissJob('Domat/Ems')).toBe(true);
  });

  it('returns true for empty location (defaults to Swiss)', () => {
    expect(isSwissJob('')).toBe(true);
  });

  it('returns false for Shanghai', () => {
    expect(isSwissJob('Shanghai')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// buildJob
// ═══════════════════════════════════════════════════════════════

describe('buildJob', () => {
  it('builds complete job object', () => {
    const job = buildJob({
      title: 'Chemist R&D',
      url: 'https://www.ems-group.com/en/career/job-vacancies/chemist',
      location: 'Domat/Ems',
    });
    expect(job).not.toBeNull();
    expect(job!.company).toBe('EMS-Chemie AG');
    expect(job!.companyKey).toBe('ems-chemie');
    expect(job!.canton).toBe('GR');
  });

  it('sets canton TG for Romanshorn', () => {
    const job = buildJob({ title: 'Test', location: 'Romanshorn' });
    expect(job!.canton).toBe('TG');
  });

  it('generates slug with company name', () => {
    const job = buildJob({ title: 'Production Operator' });
    expect(job!.slug).toContain('ems-chemie');
  });

  it('returns null for empty title', () => {
    expect(buildJob({ title: '' })).toBeNull();
    expect(buildJob(null as any)).toBeNull();
  });
});
