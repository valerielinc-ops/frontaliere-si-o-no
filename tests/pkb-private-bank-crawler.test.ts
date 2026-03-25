/**
 * Tests for the PKB Private Bank crawler parser.
 *
 * Tests parsePkbListingHtml(), parsePkbDetailHtml(), slugify(), stripHtml()
 */
import { describe, it, expect } from 'vitest';
import {
  parsePkbListingHtml,
  parsePkbDetailHtml,
  slugify,
  stripHtml,
} from '@/scripts/lib/pkb-private-bank-job-parser.mjs';

// ── Fixtures ────────────────────────────────────────────────────

const LISTING_HTML_WITH_JOB_LINKS = `
<div class="jobs-container">
  <a href="/job-details.php?id=1001" class="job-link">
    Relationship Manager - Private Banking
  </a>
  <span class="location">Lugano</span>

  <a href="/job-details.php?id=1002" class="job-link">
    Compliance Officer
  </a>
  <span class="location">Lugano</span>

  <a href="/job-details.php?id=1003" class="job-link">
    IT Systems Engineer
  </a>
  <span class="location">Lugano</span>
</div>
`;

const LISTING_HTML_WITH_ROWS = `
<div class="job-list">
  <div class="job-listing">
    <h3><a href="/positions/2001">Senior Wealth Manager</a></h3>
    <span>Lugano, TI</span>
  </div>
  <div class="job-listing">
    <h3><a href="/positions/2002">Junior Analyst - Risk Department</a></h3>
    <span>Lugano, TI</span>
  </div>
</div>
`;

const LISTING_HTML_FALLBACK = `
<div>
  <a href="/careers/apply/3001">Senior Compliance Analyst position in banking</a>
  <a href="/careers/apply/3002">Portfolio Manager for wealth management clients</a>
  <a href="/about">About PKB</a>
  <a href="/contact">Contact us</a>
</div>
`;

const DETAIL_HTML_FIXTURE = `
<div class="content">
  <h2>Relationship Manager - Private Banking</h2>
  <p>PKB Private Bank SA is looking for an experienced Relationship Manager
  to join our Private Banking team in Lugano.</p>
  <h3>Requirements</h3>
  <ul>
    <li>University degree in Finance, Economics or related field</li>
    <li>Minimum 5 years experience in private banking</li>
    <li>Fluent in Italian and English, German is a plus</li>
    <li>Strong client relationship management skills</li>
  </ul>
  <h3>What we offer</h3>
  <ul>
    <li>Competitive salary and benefits package</li>
    <li>International working environment</li>
    <li>Professional development opportunities</li>
  </ul>
</div>
`;

// ── Tests ────────────────────────────────────────────────────────

describe('PKB crawler — listing HTML parsing (Strategy 1: job-details links)', () => {
  it('extracts jobs from links with job-details pattern', () => {
    const jobs = parsePkbListingHtml(LISTING_HTML_WITH_JOB_LINKS);
    expect(jobs.length).toBe(3);
  });

  it('extracts correct titles', () => {
    const jobs = parsePkbListingHtml(LISTING_HTML_WITH_JOB_LINKS);
    const titles = jobs.map((j) => j.title);
    expect(titles).toContain('Relationship Manager - Private Banking');
    expect(titles).toContain('Compliance Officer');
    expect(titles).toContain('IT Systems Engineer');
  });

  it('builds correct URLs', () => {
    const jobs = parsePkbListingHtml(LISTING_HTML_WITH_JOB_LINKS);
    expect(jobs[0].url).toContain('careers.pkb.ch/job-details.php?id=1001');
  });

  it('sets location to Lugano', () => {
    const jobs = parsePkbListingHtml(LISTING_HTML_WITH_JOB_LINKS);
    jobs.forEach((j) => expect(j.location).toBe('Lugano'));
  });

  it('sets canton to TI', () => {
    const jobs = parsePkbListingHtml(LISTING_HTML_WITH_JOB_LINKS);
    jobs.forEach((j) => expect(j.canton).toBe('TI'));
  });
});

describe('PKB crawler — listing HTML parsing (Strategy 3: fallback)', () => {
  it('finds banking-related jobs from generic links', () => {
    const jobs = parsePkbListingHtml(LISTING_HTML_FALLBACK);
    // Should find the analyst and portfolio manager, skip about/contact
    expect(jobs.length).toBeGreaterThanOrEqual(1);
  });

  it('filters out non-job links', () => {
    const jobs = parsePkbListingHtml(LISTING_HTML_FALLBACK);
    const titles = jobs.map((j) => j.title.toLowerCase());
    expect(titles).not.toContain('about pkb');
    expect(titles).not.toContain('contact us');
  });
});

describe('PKB crawler — detail page parsing', () => {
  it('extracts description from detail page', () => {
    const result = parsePkbDetailHtml(DETAIL_HTML_FIXTURE);
    expect(result).not.toBeNull();
    expect(result!.description).toContain('Relationship Manager');
  });

  it('extracts bullet points', () => {
    const result = parsePkbDetailHtml(DETAIL_HTML_FIXTURE);
    expect(result!.bullets.length).toBeGreaterThan(0);
    expect(result!.bullets.some((b) => b.includes('University degree'))).toBe(true);
  });

  it('returns null for empty input', () => {
    expect(parsePkbDetailHtml('')).toBeNull();
    expect(parsePkbDetailHtml(null as any)).toBeNull();
  });
});

describe('PKB crawler — deduplication', () => {
  it('deduplicates jobs by title', () => {
    const doubledHtml = LISTING_HTML_WITH_JOB_LINKS + LISTING_HTML_WITH_JOB_LINKS;
    const jobs = parsePkbListingHtml(doubledHtml);
    expect(jobs.length).toBe(3);
  });
});

describe('PKB crawler — empty/null input handling', () => {
  it('returns empty for empty HTML', () => {
    expect(parsePkbListingHtml('')).toHaveLength(0);
  });

  it('returns empty for null input', () => {
    expect(parsePkbListingHtml(null as any)).toHaveLength(0);
  });
});

describe('PKB crawler — slugify', () => {
  it('generates correct slug', () => {
    expect(slugify('Relationship Manager - Private Banking')).toBe('relationship-manager-private-banking');
  });

  it('handles special characters', () => {
    expect(slugify('Senior Analyst (Risk & Compliance)')).toBe('senior-analyst-risk-compliance');
  });

  it('truncates long slugs to 180 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(180);
  });
});

describe('PKB crawler — stripHtml', () => {
  it('removes HTML tags', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).not.toMatch(/<[a-z]/i);
  });

  it('decodes entities', () => {
    expect(stripHtml('AT&amp;T')).toContain('AT&T');
  });

  it('returns empty for empty input', () => {
    expect(stripHtml('')).toBe('');
  });
});
