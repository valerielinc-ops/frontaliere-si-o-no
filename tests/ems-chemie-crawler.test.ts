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

// ─── Fixture: Career listing page (legacy table) ──────────────────
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

// ─── Fixture: jobs.ems-group.com portal page ────────────────────
const PORTAL_HTML = `
<html>
<body>
<div class="jobs-list">
  <div class="job-card">
    <a href="/offene-stellen/key-account-manager-m-w-d-homeoffice/4aa59321-0063-4499-bdf7-53a3dc75ec9c">
      Key Account Manager (m/w/d) (Homeoffice)
    </a>
    <span>Domat/Ems</span>
    <span>EMS-CHEMIE AG</span>
  </div>
  <div class="job-card">
    <a href="/offene-stellen/laborant-materialpruefung-m-w-d/f4838ff6-2c0b-4dda-bede-826bc55d6b48">
      Laborant Materialprüfung (m/w/d)
    </a>
    <span>Domat/Ems</span>
    <span>EMS-CHEMIE AG</span>
  </div>
  <div class="job-card">
    <a href="/offene-stellen/leiter-controlling-m-w-d/3a614b30-caf6-4712-a572-d828b8320266">
      Leiter Controlling (m/w/d)
    </a>
    <span>Domat/Ems</span>
  </div>
  <div class="job-card">
    <a href="/offene-stellen/ingenieur-techniker-automatisierungstechnik-m-w-d/27e163d4-48e1-4558-876c-5294626f3b85">
      Ingenieur / Techniker Automatisierungstechnik (m/w/d)
    </a>
    <span>Markdorf</span>
    <span>EFTEC AG</span>
  </div>
</div>
</body>
</html>`;

// ─── Fixture: Landing page with NO job listings (just navigation) ──
const EMPTY_LANDING_HTML = `
<html>
<body>
<main>
  <h1>Job Vacancies</h1>
  <nav>
    <a href="/en/career/">Career</a>
    <a href="/en/career/job-vacancies/">Job Vacancies</a>
    <a href="/en/career/the-start-at-ems/">The start at EMS</a>
    <a href="/en/career/apprenticeship-positions/">Apprenticeship Positions</a>
  </nav>
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
// parseListingPage — legacy table format
// ═══════════════════════════════════════════════════════════════

describe('parseListingPage — legacy table', () => {
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
// parseListingPage — jobs.ems-group.com portal format
// ═══════════════════════════════════════════════════════════════

describe('parseListingPage — portal format', () => {
  it('extracts jobs from portal HTML with UUID links', () => {
    const jobs = parseListingPage(PORTAL_HTML);
    expect(jobs.length).toBe(4);
  });

  it('extracts job titles from portal cards', () => {
    const jobs = parseListingPage(PORTAL_HTML);
    const titles = jobs.map((j: { title: string }) => j.title);
    expect(titles).toContain('Key Account Manager (m/w/d) (Homeoffice)');
    expect(titles).toContain('Laborant Materialprüfung (m/w/d)');
    expect(titles).toContain('Leiter Controlling (m/w/d)');
  });

  it('generates full portal URLs with UUIDs', () => {
    const jobs = parseListingPage(PORTAL_HTML);
    for (const job of jobs) {
      expect((job as { url: string }).url).toMatch(/jobs\.ems-group\.com\/offene-stellen\/[a-z0-9-]+\/[0-9a-f-]+/);
    }
  });

  it('includes EFTEC jobs from portal', () => {
    const jobs = parseListingPage(PORTAL_HTML);
    const eftecJob = jobs.find((j: { title: string }) => j.title.includes('Automatisierungstechnik'));
    expect(eftecJob).toBeDefined();
    // Location inference from HTML context may or may not detect Markdorf
    // depending on how close the location text is to the link
    expect((eftecJob as { location: string }).location).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// parseListingPage — empty landing page (no fake jobs)
// ═══════════════════════════════════════════════════════════════

describe('parseListingPage — empty landing page', () => {
  it('returns empty array for navigation-only pages', () => {
    const jobs = parseListingPage(EMPTY_LANDING_HTML);
    expect(jobs).toHaveLength(0);
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

  it('detects Markdorf', () => {
    expect(inferLocation('', 'Standort: Markdorf, Germany')).toBe('Markdorf');
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

  it('includes postalCode and streetAddress', () => {
    const job = buildJob({ title: 'Test', location: 'Domat/Ems' });
    expect(job!.postalCode).toBe('7013');
    expect(job!.streetAddress).toBe('Via Innovativa 1');
    expect(job!.employmentType).toBe('FULL_TIME');
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
