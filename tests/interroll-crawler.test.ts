/**
 * Interroll Group — TYPO3 careers page parser tests
 */
import fs from 'node:fs';
import { describe, it, expect } from 'vitest';

import {
  parseListingPage,
  classifyInterrollListings,
  parseDetailPage,
  isSwissLocation,
  slugify,
  detectCategory,
  detectExperienceLevel,
  MIN_DESC_LENGTH,
  extractInterrollJobBody,
} from '@/scripts/lib/interroll-job-parser.mjs';
import {
  resolveInterrollSiteAddress,
  INTERROLL_SITES,
  buildInterrollJob,
} from '@/scripts/update-interroll-jobs.mjs';

const INTERROLL_UPDATER = fs.readFileSync(
  new URL('../scripts/update-interroll-jobs.mjs', import.meta.url),
  'utf8',
);

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

  it('keeps the country when the live card puts the department before it', () => {
    const jobs = parseListingPage(`
      <div class="job-listing-item">
        <h3>Area Sales Manager Solutions</h3>
        <p>Aussendienst | Germany</p>
        <a href="/careers/jobs/job-detail/area-sales-manager">Details</a>
      </div>
      <div class="job-listing-item">
        <h3>Area Sales Manager Solutions</h3>
        <p>Kettering | United Kingdom</p>
        <a href="/careers/jobs/job-detail/area-sales-manager-uk">Details</a>
      </div>
    `);

    expect(jobs.map((job) => job.location)).toEqual([
      'Aussendienst | Germany',
      'Kettering | United Kingdom',
    ]);
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

describe('classifyInterrollListings', () => {
  it('reports a reachable global board filtered to zero Swiss jobs with a proof', () => {
    const result = classifyInterrollListings([
      { title: 'Area Sales Manager', url: 'https://www.interroll.com/job-detail/sales', location: 'Germany' },
      { title: 'Service Techniker', url: 'https://www.interroll.com/job-detail/service', location: 'Austria' },
    ]);

    expect(result.discovered).toBe(2);
    expect(result.listings).toEqual([]);
    expect(result.lastFetchOutcome).toBe('filtered_empty');
    expect(result.authoritativeEmptySnapshot).toBe(true);
    expect(result.unclassifiedLocationCount).toBe(0);
  });

  it('does not prove a filtered zero when any card has no recognized location', () => {
    const result = classifyInterrollListings([
      { title: 'Area Sales Manager', url: 'https://www.interroll.com/job-detail/sales', location: 'Germany' },
      { title: 'Unknown role', url: 'https://www.interroll.com/job-detail/unknown', location: '' },
    ]);

    expect(result.lastFetchOutcome).toBe('filtered_empty');
    expect(result.authoritativeEmptySnapshot).toBe(false);
    expect(result.unclassifiedLocationCount).toBe(1);
  });

  it('recognizes a Swiss country after the department separator', () => {
    const result = classifyInterrollListings([
      {
        title: 'Mechanical Design Engineer',
        url: 'https://www.interroll.com/job-detail/mechanical-design',
        location: 'R&D | Sant\'Antonino | Switzerland',
      },
    ]);

    expect(result.listings).toHaveLength(1);
    expect(result.lastFetchOutcome).toBe('ok');
    expect(result.authoritativeEmptySnapshot).toBe(false);
  });

  it('keeps an empty fetched board fail-closed as a selector miss', () => {
    expect(classifyInterrollListings([])).toMatchObject({
      discovered: 0,
      listings: [],
      lastFetchOutcome: 'selector_miss',
    });
  });
});

describe('filtered-empty heartbeat wiring', () => {
  it('writes a normal summary instead of leaving the process-exit guard as the only signal', () => {
    expect(INTERROLL_UPDATER).toContain(
      "if (summaryCounts.lastFetchOutcome === 'filtered_empty')",
    );
    const filteredEmptyPath = INTERROLL_UPDATER.slice(
      INTERROLL_UPDATER.indexOf("if (summaryCounts.lastFetchOutcome === 'filtered_empty')"),
    );
    expect(filteredEmptyPath).toContain(
      'writeInterrollSummary({ counts: summaryCounts });',
    );
    expect(INTERROLL_UPDATER).toContain(
      'lastFetchOutcome: counts.lastFetchOutcome',
    );
    expect(INTERROLL_UPDATER).toContain(
      'authoritativeEmptySnapshot: counts.authoritativeEmptySnapshot === true && sliceJobs.length === 0',
    );
    expect(INTERROLL_UPDATER).toContain('publishAuthoritativeEmptySnapshot');
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

// ─── Site resolver (preventive: only Sant'Antonino is known) ───────────────

describe('resolveInterrollSiteAddress', () => {
  it("matches Sant'Antonino (apostrophe variant)", () => {
    const site = resolveInterrollSiteAddress("Sant'Antonino, Switzerland");
    expect(site).not.toBeNull();
    expect(site?.canton).toBe('TI');
    expect(site?.postalCode).toBe('6592');
    expect(site?.streetAddress).toBe('Via Gorelle 3');
  });

  it('matches Sant Antonino (space variant)', () => {
    const site = resolveInterrollSiteAddress('Sant Antonino, Switzerland');
    expect(site?.canton).toBe('TI');
  });

  it('returns null for unknown Swiss location (caller must skip, not invent)', () => {
    expect(resolveInterrollSiteAddress('Wermelskirchen, Switzerland')).toBeNull();
    expect(resolveInterrollSiteAddress('Zurich, Switzerland')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(resolveInterrollSiteAddress('')).toBeNull();
  });

  it('registry only contains the confirmed Sant\'Antonino site', () => {
    expect(INTERROLL_SITES).toHaveLength(1);
    expect(INTERROLL_SITES[0].key).toBe('sant-antonino');
  });
});

// ─── Source text only (issue 5253) ──────────────────────────────────────────
// Minimized from the live interroll.com job page (2026-09-29): the vacancy is
// `.tx-jobs .news-detail-content`; the page around it is a 40k-character
// mega-menu that `parseDetailPage`'s generic fallback would have published.
const LIVE_TEMPLATE_DETAIL = `
<html><body>
<nav class="mega-menu"><div class="mega-menu-items-collapse-content">English Deutsch Products Solutions Industries Careers</div></nav>
<div class="tx-jobs"><div class="module news-detail">
  <div class="news-detail-header"><a href="/careers/jobs/">Back to overview</a> Aussendienst, Germany <h1>Area Sales Manager Products (m/v/d)</h1></div>
  <div class="news-detail-content"><div class="inner"><div class="left">
    <p>The Interroll Group is the leading global provider of material-handling solutions. The company was founded in 1959 and has been listed on the SIX Swiss Exchange since 1997.</p>
    <p>Interroll provides system integrators and OEMs with a wide range of platform-based products and services in these categories: Rollers (conveyor rollers), Drives (motors and drives for conveyor systems), Conveyors &amp; Sorters as well as Pallet Handling (flow storage systems).</p>
    <p><strong>What are my responsibilities?</strong></p>
    <ul>
      <li>Acquisition of new customers and key account management for the sales area</li>
      <li>Development and implementation of strategies and action plans to increase sales</li>
    </ul>
  </div></div></div>
</div></div>
</body></html>`;

describe('Interroll source text only (issue 5253)', () => {
  const site = INTERROLL_SITES[0];
  const raw = { title: 'Area Sales Manager Products (m/v/d)', url: 'https://www.interroll.com/careers/jobs/job-detail/area-sales-manager', location: "Sant'Antonino" };

  it('reads only the vacancy container, never the navigation', () => {
    const body = extractInterrollJobBody(LIVE_TEMPLATE_DETAIL);
    expect(body).toContain('The Interroll Group is the leading global provider');
    expect(body).toContain('• Acquisition of new customers');
    expect(body).not.toContain('Products Solutions Industries');
    expect(body).not.toContain('Back to overview');
  });

  it('returns nothing for a page without a vacancy container', () => {
    expect(extractInterrollJobBody('<main><div>Products Solutions Industries Careers and a long navigation text</div></main>')).toBe('');
  });

  it('publishes the vacancy text in its own language instead of an invented sentence', () => {
    const job = buildInterrollJob(raw, site, extractInterrollJobBody(LIVE_TEMPLATE_DETAIL));
    expect(job?.sourceLang).toBe('en');
    expect(job?.descriptionByLocale).toEqual({ en: job?.description });
    expect(job?.description).not.toMatch(/position at Interroll Group in/);
  });

  it('does not publish a job without at least 50 words of source text', () => {
    expect(buildInterrollJob(raw, site, '')).toBeNull();
    expect(buildInterrollJob(raw, site, 'Area Sales Manager Products.')).toBeNull();
  });
});
