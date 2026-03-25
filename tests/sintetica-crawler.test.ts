/**
 * Sintetica SA — NCore Platform parser tests
 */
import { describe, it, expect } from 'vitest';

import {
  parseListingPage,
  parseDetailPage,
  slugify,
  detectCategory,
  detectExperienceLevel,
  MIN_DESC_LENGTH,
} from '@/scripts/lib/sintetica-job-parser.mjs';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const FIXTURE_LISTING_PAGE = `
<!DOCTYPE html>
<html>
<head><title>Sintetica - Job Board</title></head>
<body>
<div class="job-board">
  <div class="singlePosition">
    <h3>Pharmaceutical Development Project Manager</h3>
    <p>We are looking for a highly motivated and experienced Pharmaceutical Development Project Manager...</p>
    <a href="/jobposition/788026/pharmaceutical-development-project-manager-ch/sintetica" class="btn btn-danger">Candidati Ora</a>
  </div>
  <div class="singlePosition">
    <h3>Quality Control Microbiological Laboratory Technician</h3>
    <p>Quality Control Microbiological Laboratory Technician position at our Mendrisio site...</p>
    <a href="/jobposition/778848/quality-control-microbiological-laboratory-technician-ch/sintetica" class="btn btn-danger">Candidati Ora</a>
  </div>
  <div class="singlePosition">
    <h3>Production Engineer</h3>
    <p>Sintetica SA is searching for a Production Engineer to optimize our manufacturing processes...</p>
    <a href="/jobposition/777664/production-engineer-ch/sintetica" class="btn btn-danger">Candidati Ora</a>
  </div>
  <div class="singlePosition">
    <h3>Regulatory Affairs Specialist</h3>
    <p>We are looking for a Regulatory Affairs Specialist to support our regulatory activities...</p>
    <a href="/jobposition/774403/regulatory-affairs-specialist-mendrisio-site-ticino-ch/sintetica" class="btn btn-danger">Candidati Ora</a>
  </div>
  <div class="singlePosition">
    <h3>Apprendista tecnologo di chimica e chimica farmaceutica</h3>
    <p>Offriamo un posto di apprendistato come tecnologo di chimica e chimica farmaceutica...</p>
    <a href="/jobposition/780433/apprendista-tecnologo-di-chimica-e-chimica-farmaceutica-con-maturita-professionale-mendrisio-site-ticino-ch/sintetica" class="btn btn-danger">Candidati Ora</a>
  </div>
</div>
</body>
</html>
`;

const FIXTURE_DETAIL_PAGE = `
<!DOCTYPE html>
<html>
<head><title>Pharmaceutical Development Project Manager - Sintetica</title></head>
<body>
<div class="job-description">
  <h1>Pharmaceutical Development Project Manager</h1>
  <div class="position-description">
    <p>Sintetica SA, a leading Swiss pharmaceutical company based in Mendrisio (Ticino), is looking for a <strong>Pharmaceutical Development Project Manager</strong> to lead our product development pipeline.</p>
    <p><strong>Key Responsibilities:</strong></p>
    <ul>
      <li>Manage pharmaceutical development projects from concept to commercialization.</li>
      <li>Coordinate cross-functional teams including formulation, analytical, regulatory and manufacturing.</li>
      <li>Prepare and maintain project plans, timelines, budgets, and risk assessments.</li>
      <li>Ensure compliance with GMP, ICH guidelines, and applicable regulatory requirements.</li>
      <li>Interface with CMOs and external development partners.</li>
    </ul>
    <p><strong>Requirements:</strong></p>
    <ul>
      <li>MSc/PhD in Pharmaceutical Sciences, Chemistry or related field.</li>
      <li>5+ years of project management experience in pharmaceutical development.</li>
      <li>Knowledge of EU/CH regulatory requirements for pharmaceutical products.</li>
      <li>Excellent organizational, communication and leadership skills.</li>
      <li>Fluent in English; Italian and/or French is a plus.</li>
    </ul>
  </div>
</div>
</body>
</html>
`;

// ─── parseListingPage tests ─────────────────────────────────────────────────

describe('parseListingPage', () => {
  it('finds five jobs in the fixture', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs).toHaveLength(5);
  });

  it('extracts correct titles', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs[0].title).toBe('Pharmaceutical Development Project Manager');
    expect(jobs[1].title).toBe('Quality Control Microbiological Laboratory Technician');
    expect(jobs[4].title).toBe('Apprendista tecnologo di chimica e chimica farmaceutica');
  });

  it('extracts job IDs from URLs', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs[0].id).toBe('788026');
    expect(jobs[1].id).toBe('778848');
  });

  it('builds absolute URLs', () => {
    const jobs = parseListingPage(FIXTURE_LISTING_PAGE);
    expect(jobs[0].url).toContain('ncoreplat.com');
    expect(jobs[0].url).toContain('788026');
  });

  it('returns empty array for empty input', () => {
    expect(parseListingPage('')).toHaveLength(0);
  });

  it('deduplicates by job ID', () => {
    const doubledHtml = FIXTURE_LISTING_PAGE.replace('</body>', '') + FIXTURE_LISTING_PAGE;
    const jobs = parseListingPage(doubledHtml);
    const ids = jobs.map(j => j.id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });
});

// ─── parseDetailPage tests ──────────────────────────────────────────────────

describe('parseDetailPage', () => {
  it('extracts the title', () => {
    const result = parseDetailPage(FIXTURE_DETAIL_PAGE);
    expect(result.title).toBe('Pharmaceutical Development Project Manager');
  });

  it('extracts the description body', () => {
    const result = parseDetailPage(FIXTURE_DETAIL_PAGE);
    expect(result.body).toContain('Sintetica SA');
    expect(result.body).toContain('GMP');
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
  it('detects pharma for Regulatory Affairs', () => {
    expect(detectCategory('Regulatory Affairs Specialist')).toBe('pharma');
  });

  it('detects science for QC Lab Technician (laboratory keyword)', () => {
    expect(detectCategory('Quality Control Microbiological Laboratory Technician')).toBe('science');
  });

  it('detects quality for Quality Assurance Specialist', () => {
    expect(detectCategory('Quality Assurance Specialist')).toBe('quality');
  });

  it('detects production for Production Engineer', () => {
    expect(detectCategory('Production Engineer')).toBe('production');
  });

  it('detects internship for Apprendista', () => {
    expect(detectCategory('Apprendista tecnologo di chimica')).toBe('internship');
  });
});

describe('detectExperienceLevel', () => {
  it('detects ENTRY for Apprendista', () => {
    expect(detectExperienceLevel('Apprendista tecnologo di chimica')).toBe('ENTRY');
  });

  it('detects SENIOR for Senior title', () => {
    expect(detectExperienceLevel('Senior Process Engineer')).toBe('SENIOR');
  });

  it('detects MID for regular title', () => {
    expect(detectExperienceLevel('Production Engineer')).toBe('MID');
  });
});
