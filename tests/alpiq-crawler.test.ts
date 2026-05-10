/**
 * Tests for the Alpiq crawler parser.
 *
 * Tests parseAlpiqListingHtml(), parseAlpiqJobBlock(),
 * isTicinoLocation(), isSwissLocation(), slugify(), stripHtml()
 */
import { describe, it, expect } from 'vitest';
import {
  parseAlpiqListingHtml,
  parseAlpiqJobBlock,
  parseAlpiqDetailHtml,
  isTicinoLocation,
  isSwissLocation,
  slugify,
  stripHtml,
} from '@/scripts/lib/alpiq-job-parser.mjs';

// ── Fixtures ────────────────────────────────────────────────────

const JOB_BLOCK_SWISS = `
<li class="job-item">
  <span class="category">Assets</span>
  <a href="/career/open-jobs/your-application/9433">Head Market Risk Asset (all) 80-100%</a>
  <p>Lead market risk management for the asset portfolio.</p>
  <span class="location">Lausanne - 80-100% Permanent</span>
</li>
`;

const JOB_BLOCK_ITALY = `
<li class="job-item">
  <span class="category">Operations</span>
  <a href="/career/open-jobs/your-application/9458">Operation & Maintenance Supervisor</a>
  <p>Supervise O&M activities for green power plants.</p>
  <span class="location">Cammarata - 100% Permanent</span>
</li>
`;

const JOB_BLOCK_TICINO = `
<li class="job-item">
  <span class="category">Operations</span>
  <a href="/career/open-jobs/your-application/9500">Operatore Centrale Idroelettrica</a>
  <p>Gestione impianto idroelettrico in Ticino.</p>
  <span class="location">Airolo - 100% Permanent</span>
</li>
`;

const LISTING_HTML_FIXTURE = JOB_BLOCK_SWISS + JOB_BLOCK_ITALY + JOB_BLOCK_TICINO;

const DETAIL_HTML_FIXTURE = `
<div class="job-detail">
  <h2>Head Market Risk Asset (all) 80-100%</h2>
  <p>Alpiq is one of the largest energy producers in Switzerland.</p>
  <strong>Your responsibilities</strong>
  <ul>
    <li>Lead market risk management for the asset portfolio</li>
    <li>Develop risk models and reporting frameworks</li>
  </ul>
  <strong>Your profile</strong>
  <ul>
    <li>Master's degree in Finance, Mathematics, or Engineering</li>
    <li>5+ years experience in energy trading risk management</li>
    <li>Fluent in English, German or French is a plus</li>
  </ul>
</div>
`;

// ── Tests ────────────────────────────────────────────────────────

describe('Alpiq crawler — location filtering', () => {
  it('identifies Ticino locations', () => {
    expect(isTicinoLocation('Airolo')).toBe(true);
    expect(isTicinoLocation('Biasca')).toBe(true);
    expect(isTicinoLocation('Locarno')).toBe(true);
    expect(isTicinoLocation('Ritom')).toBe(true);
  });

  it('rejects non-Ticino locations', () => {
    // Cathedral 2026-05-10: TARGET_CANTONS expanded to all 26 CH cantons;
    // only foreign/non-CH locations should be false now.
    expect(isTicinoLocation('Cammarata')).toBe(false); // Italian city, not CH
    expect(isTicinoLocation('Madrid')).toBe(false);    // Spanish city, not CH
    expect(isTicinoLocation('Berlin')).toBe(false);    // German city, not CH
  });

  it('identifies Swiss locations', () => {
    expect(isSwissLocation('Lausanne')).toBe(true);
    expect(isSwissLocation('Zurich')).toBe(true);
    expect(isSwissLocation('Switzerland')).toBe(true);
    expect(isSwissLocation('Airolo')).toBe(true);
  });

  it('rejects non-Swiss locations', () => {
    expect(isSwissLocation('Cammarata')).toBe(false);
    expect(isSwissLocation('Madrid')).toBe(false);
    expect(isSwissLocation('Paris')).toBe(false);
  });
});

describe('Alpiq crawler — job block parsing', () => {
  it('parses a Swiss job block', () => {
    const job = parseAlpiqJobBlock(JOB_BLOCK_SWISS);
    expect(job).not.toBeNull();
    expect(job!.title).toBe('Head Market Risk Asset (all) 80-100%');
    expect(job!.jobId).toBe('9433');
    expect(job!.url).toContain('alpiq.com/career/open-jobs');
  });

  it('extracts apply URL with SuccessFactors', () => {
    const job = parseAlpiqJobBlock(JOB_BLOCK_SWISS);
    expect(job!.applyUrl).toContain('career5.successfactors.eu');
    expect(job!.applyUrl).toContain('9433');
  });

  it('returns null for blocks without job links', () => {
    expect(parseAlpiqJobBlock('<div>No job here</div>')).toBeNull();
    expect(parseAlpiqJobBlock(null as any)).toBeNull();
  });
});

describe('Alpiq crawler — listing HTML parsing with Swiss filter', () => {
  it('filters out non-Swiss jobs by default', () => {
    const jobs = parseAlpiqListingHtml(LISTING_HTML_FIXTURE, { swissOnly: true });
    const locations = jobs.map((j) => j.location);
    expect(locations).not.toContain('Cammarata');
  });

  it('keeps Swiss and Ticino jobs', () => {
    const jobs = parseAlpiqListingHtml(LISTING_HTML_FIXTURE, { swissOnly: true });
    expect(jobs.length).toBeGreaterThanOrEqual(1);
  });

  it('returns all jobs when swissOnly is false', () => {
    const jobs = parseAlpiqListingHtml(LISTING_HTML_FIXTURE, { swissOnly: false });
    expect(jobs.length).toBe(3);
  });

  it('returns empty for empty input', () => {
    expect(parseAlpiqListingHtml('')).toHaveLength(0);
    expect(parseAlpiqListingHtml(null as any)).toHaveLength(0);
  });
});

describe('Alpiq crawler — detail page parsing', () => {
  it('extracts title from detail page', () => {
    const result = parseAlpiqDetailHtml(DETAIL_HTML_FIXTURE);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('Head Market Risk Asset');
  });

  it('extracts bullet points', () => {
    const result = parseAlpiqDetailHtml(DETAIL_HTML_FIXTURE);
    expect(result!.bullets.length).toBeGreaterThan(0);
  });

  it('returns null for empty input', () => {
    expect(parseAlpiqDetailHtml('')).toBeNull();
  });
});

describe('Alpiq crawler — slugify', () => {
  it('generates correct slug', () => {
    expect(slugify('Head Market Risk Asset (all) 80-100%')).toBe('head-market-risk-asset-all-80-100');
  });

  it('handles umlauts', () => {
    expect(slugify('Zürich Operations')).toBe('zurich-operations');
  });
});
