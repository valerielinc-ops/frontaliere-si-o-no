/**
 * Rivopharm SA crawler parser tests
 *
 * Tests parseRivopharmJobs(), htmlToText(), and slugify() using HTML fixtures
 * that mirror typical career page structures.
 */
import { describe, it, expect } from 'vitest';
import { parseRivopharmJobs, htmlToText, slugify, normalizeSpace, MIN_DESC_LENGTH } from '@/scripts/lib/rivopharm-job-parser.mjs';

// ─── Fixture: Job cards with class-based identification ────────────────────────

const FIXTURE_JOB_CARDS = `
<html><body>
<h1>Careers at Rivopharm</h1>
<div class="job-listing">
  <article class="job-card">
    <h3>Quality Assurance Specialist</h3>
    <p>We are looking for a Quality Assurance Specialist to join our pharmaceutical manufacturing team in Manno, Canton Ticino. The successful candidate will be responsible for maintaining and improving our quality management system in line with Swiss and European pharmaceutical regulations and GMP guidelines.</p>
    <p><strong>Requirements:</strong></p>
    <ul>
      <li>Degree in Chemistry, Pharmacy, Biology, or related scientific field.</li>
      <li>Minimum 3 years of QA experience in a pharmaceutical environment.</li>
      <li>Knowledge of ICH guidelines and Swiss/EU GMP regulations.</li>
      <li>Fluent in English; Italian is a strong advantage.</li>
    </ul>
    <a href="/careers/qa-specialist">Apply now</a>
  </article>
  <article class="job-card">
    <h3>Production Operator — Pharmaceutical Manufacturing</h3>
    <p>Rivopharm SA is seeking a Production Operator for our generic pharmaceutical manufacturing facility in Manno. This role involves operating and maintaining production equipment in compliance with GMP standards and validated SOPs. The ideal candidate has prior experience in pharmaceutical or chemical production environments.</p>
    <p><strong>Responsibilities:</strong></p>
    <ul>
      <li>Operate production equipment according to validated standard operating procedures.</li>
      <li>Record production data accurately in batch documentation systems.</li>
      <li>Maintain GMP compliance in the production area at all times.</li>
    </ul>
    <a href="/careers/production-operator">Apply</a>
  </article>
</div>
</body></html>
`;

// ─── Fixture: Heading-based job structure ──────────────────────────────────────

const FIXTURE_HEADING_JOBS = `
<html><body>
<h1>Open Positions</h1>
<h3>Regulatory Affairs Manager</h3>
<p>We are looking for an experienced Regulatory Affairs Manager to oversee the submission and maintenance of pharmaceutical product registrations across European and international markets. The role requires deep knowledge of Swissmedic, EMA, and ICH regulatory frameworks, and the ability to coordinate cross-functional teams to ensure timely submissions and compliance.</p>
<ul>
  <li>Manage regulatory submissions for new and existing products</li>
  <li>Coordinate with quality assurance, R&D, and production teams</li>
  <li>Ensure compliance with local and international pharmaceutical regulations</li>
  <li>Monitor regulatory changes and assess impact on product portfolio</li>
</ul>
<h3>Contact Us</h3>
<p>For general inquiries, please contact our HR department.</p>
</body></html>
`;

// ─── Fixture: Empty / no jobs ─────────────────────────────────────────────────

const FIXTURE_NO_JOBS = `
<html><body>
<h1>Careers at Rivopharm</h1>
<p>There are currently no open positions. Please check back later.</p>
</body></html>
`;

// ─── parseRivopharmJobs tests ─────────────────────────────────────────────────

describe('parseRivopharmJobs — job cards fixture', () => {
  it('finds two jobs from card-based HTML', () => {
    const jobs = parseRivopharmJobs(FIXTURE_JOB_CARDS);
    expect(jobs).toHaveLength(2);
  });

  it('extracts correct titles', () => {
    const jobs = parseRivopharmJobs(FIXTURE_JOB_CARDS);
    expect(jobs[0].title).toBe('Quality Assurance Specialist');
    expect(jobs[1].title).toContain('Production Operator');
  });

  it('sets location to Manno by default', () => {
    const jobs = parseRivopharmJobs(FIXTURE_JOB_CARDS);
    for (const job of jobs) {
      expect(job.location).toBe('Manno');
    }
  });

  it('extracts URLs from href attributes', () => {
    const jobs = parseRivopharmJobs(FIXTURE_JOB_CARDS);
    expect(jobs[0].url).toContain('qa-specialist');
  });

  it('assigns sequential idx', () => {
    const jobs = parseRivopharmJobs(FIXTURE_JOB_CARDS);
    expect(jobs[0].idx).toBe(1);
    expect(jobs[1].idx).toBe(2);
  });

  it('description meets minimum length', () => {
    const jobs = parseRivopharmJobs(FIXTURE_JOB_CARDS);
    for (const job of jobs) {
      expect(job.descriptionText.length).toBeGreaterThanOrEqual(MIN_DESC_LENGTH);
    }
  });
});

describe('parseRivopharmJobs — heading-based fixture', () => {
  it('finds one job from heading structure', () => {
    const jobs = parseRivopharmJobs(FIXTURE_HEADING_JOBS);
    expect(jobs.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts Regulatory Affairs Manager title', () => {
    const jobs = parseRivopharmJobs(FIXTURE_HEADING_JOBS);
    const regJob = jobs.find((j) => j.title.includes('Regulatory'));
    expect(regJob).toBeDefined();
    expect(regJob!.title).toBe('Regulatory Affairs Manager');
  });
});

describe('parseRivopharmJobs — guards', () => {
  it('returns empty array for empty input', () => {
    expect(parseRivopharmJobs('')).toHaveLength(0);
  });

  it('returns empty array for null/undefined', () => {
    expect(parseRivopharmJobs(null as any)).toHaveLength(0);
    expect(parseRivopharmJobs(undefined as any)).toHaveLength(0);
  });

  it('returns empty array when no jobs present', () => {
    const jobs = parseRivopharmJobs(FIXTURE_NO_JOBS);
    expect(jobs).toHaveLength(0);
  });
});

// ─── htmlToText tests ─────────────────────────────────────────────────────────

describe('htmlToText', () => {
  it('strips HTML tags', () => {
    const result = htmlToText('<p>Hello <strong>world</strong></p>');
    expect(result).not.toMatch(/<[a-z]/i);
    expect(result).toContain('Hello');
    expect(result).toContain('world');
  });

  it('decodes common entities', () => {
    const result = htmlToText('AT&amp;T &lt;test&gt;');
    expect(result).toContain('AT&T');
    expect(result).toContain('<test>');
  });

  it('returns empty string for null', () => {
    expect(htmlToText(null as any)).toBe('');
    expect(htmlToText('')).toBe('');
  });

  it('removes script and style content', () => {
    const result = htmlToText('<script>alert("xss")</script><style>.foo{}</style><p>Safe</p>');
    expect(result).not.toContain('alert');
    expect(result).toContain('Safe');
  });
});

// ─── slugify tests ────────────────────────────────────────────────────────────

describe('slugify', () => {
  it('converts to lowercase kebab-case', () => {
    expect(slugify('Quality Assurance Specialist')).toBe('quality-assurance-specialist');
  });

  it('appends suffix when provided', () => {
    expect(slugify('QA Specialist', 'rivopharm')).toBe('qa-specialist-rivopharm');
  });

  it('removes accented characters', () => {
    expect(slugify('Responsabile Qualità')).toBe('responsabile-qualita');
  });

  it('handles empty input', () => {
    expect(slugify('')).toBe('');
    expect(slugify(null as any)).toBe('');
  });
});
