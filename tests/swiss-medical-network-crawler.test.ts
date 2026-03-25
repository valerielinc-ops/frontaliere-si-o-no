/**
 * Swiss Medical Network crawler parser tests
 *
 * Tests parseSwissMedicalJobs(), parseSmartRecruiterLinks(),
 * isTicinoLocation(), and inferCity() using HTML fixtures.
 */
import { describe, it, expect } from 'vitest';
import {
  parseSwissMedicalJobs,
  parseSmartRecruiterLinks,
  isTicinoLocation,
  inferCity,
  normalizeSpace,
  slugify,
  TICINO_CLINICS,
} from '@/scripts/lib/swiss-medical-network-job-parser.mjs';

// ─── Fixture: Ticino job listings with SmartRecruiters links ──────────────────

const FIXTURE_TICINO_JOBS = `
<html><body>
<div class="job-offers">
  <div class="job-card">
    <h3>Medico Ospedaliero</h3>
    <p>Clinica Sant'Anna, Sorengo</p>
    <p>Tasso di occupazione: 100%</p>
    <p>Inizio: Da subito o da convenire</p>
    <a href="https://jobs.smartrecruiters.com/SwissMedicalNetwork1/medico-ospedaliero-sorengo">Candidarsi</a>
  </div>
  <div class="job-card">
    <h3>Infermiere/a di Sala Operatoria</h3>
    <p>Clinica Ars Medica, Gravesano</p>
    <p>Tasso di occupazione: 80-100%</p>
    <a href="https://jobs.smartrecruiters.com/SwissMedicalNetwork1/infermiere-sala-operatoria">Candidarsi</a>
  </div>
</div>
</body></html>
`;

// ─── Fixture: Mixed locations (Ticino + non-Ticino) ───────────────────────────

const FIXTURE_MIXED = `
<html><body>
<div class="job-card">
  <h3>Physiothérapeute</h3>
  <p>Clinique de Genolier, Genolier</p>
  <a href="https://jobs.smartrecruiters.com/SwissMedicalNetwork1/physio-genolier">Apply</a>
</div>
<div class="job-card">
  <h3>Assistente di Cura</h3>
  <p>Clinica Moncucco, Lugano</p>
  <p>100%</p>
  <a href="https://jobs.smartrecruiters.com/SwissMedicalNetwork1/assistente-cura-lugano">Candidarsi</a>
</div>
</body></html>
`;

// ─── Fixture: No SmartRecruiters links ────────────────────────────────────────

const FIXTURE_NO_SR = `
<html><body>
<h1>Career Opportunities</h1>
<p>No positions currently available in this region.</p>
</body></html>
`;

// ─── parseSwissMedicalJobs tests ──────────────────────────────────────────────

describe('parseSwissMedicalJobs — Ticino jobs', () => {
  it('finds Ticino jobs', () => {
    const jobs = parseSwissMedicalJobs(FIXTURE_TICINO_JOBS);
    expect(jobs.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts at least one correct title', () => {
    const jobs = parseSwissMedicalJobs(FIXTURE_TICINO_JOBS);
    const titles = jobs.map((j) => j.title);
    expect(titles.some((t) => t.includes('Medico') || t.includes('Infermiere'))).toBe(true);
  });

  it('extracts SmartRecruiters URLs', () => {
    const jobs = parseSwissMedicalJobs(FIXTURE_TICINO_JOBS);
    for (const job of jobs) {
      expect(job.applyUrl).toContain('smartrecruiters.com');
    }
  });

  it('infers Ticino cities', () => {
    const jobs = parseSwissMedicalJobs(FIXTURE_TICINO_JOBS);
    const validCities = ['Sorengo', 'Gravesano', 'Lugano', 'Bellinzona', 'Locarno', 'Mendrisio', 'Acquarossa'];
    for (const job of jobs) {
      expect(validCities).toContain(job.city);
    }
  });

  it('assigns sequential idx', () => {
    const jobs = parseSwissMedicalJobs(FIXTURE_TICINO_JOBS);
    if (jobs.length >= 1) expect(jobs[0].idx).toBe(1);
    if (jobs.length >= 2) expect(jobs[1].idx).toBe(2);
  });
});

describe('parseSwissMedicalJobs — mixed locations', () => {
  it('filters out non-Ticino jobs', () => {
    const jobs = parseSwissMedicalJobs(FIXTURE_MIXED);
    // Should find the Lugano job but not the Genolier job
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    const cities = jobs.map((j) => j.city);
    expect(cities).toContain('Lugano');
    expect(cities).not.toContain('Genolier');
  });
});

describe('parseSwissMedicalJobs — guards', () => {
  it('returns empty for empty input', () => {
    expect(parseSwissMedicalJobs('')).toHaveLength(0);
  });

  it('returns empty when no SmartRecruiters links', () => {
    expect(parseSwissMedicalJobs(FIXTURE_NO_SR)).toHaveLength(0);
  });

  it('handles null/undefined', () => {
    expect(parseSwissMedicalJobs(null as any)).toHaveLength(0);
  });
});

// ─── parseSmartRecruiterLinks tests ───────────────────────────────────────────

describe('parseSmartRecruiterLinks', () => {
  it('extracts all SmartRecruiters URLs', () => {
    const links = parseSmartRecruiterLinks(FIXTURE_TICINO_JOBS);
    expect(links).toHaveLength(2);
    expect(links[0]).toContain('smartrecruiters.com/SwissMedicalNetwork');
  });

  it('returns empty for no links', () => {
    expect(parseSmartRecruiterLinks(FIXTURE_NO_SR)).toHaveLength(0);
  });

  it('deduplicates URLs', () => {
    const html = `
      <a href="https://jobs.smartrecruiters.com/SwissMedicalNetwork1/same-job">Apply</a>
      <a href="https://jobs.smartrecruiters.com/SwissMedicalNetwork1/same-job">Apply again</a>
    `;
    const links = parseSmartRecruiterLinks(html);
    expect(links).toHaveLength(1);
  });
});

// ─── isTicinoLocation tests ───────────────────────────────────────────────────

describe('isTicinoLocation', () => {
  it('returns true for Sorengo', () => { expect(isTicinoLocation('Sorengo')).toBe(true); });
  it('returns true for Lugano', () => { expect(isTicinoLocation('Lugano')).toBe(true); });
  it('returns true for Clinica Sant\'Anna', () => { expect(isTicinoLocation('Clinica Sant\'Anna')).toBe(true); });
  it('returns false for Genolier', () => { expect(isTicinoLocation('Genolier')).toBe(false); });
  it('returns false for Zurich', () => { expect(isTicinoLocation('Zurich')).toBe(false); });
});

// ─── inferCity tests ──────────────────────────────────────────────────────────

describe('inferCity', () => {
  it('infers Sorengo from Clinica Sant\'Anna', () => { expect(inferCity('Clinica Sant\'Anna')).toBe('Sorengo'); });
  it('infers Gravesano from Ars Medica', () => { expect(inferCity('Clinica Ars Medica')).toBe('Gravesano'); });
  it('infers Lugano from Moncucco', () => { expect(inferCity('Clinica Moncucco')).toBe('Lugano'); });
  it('defaults to Lugano for unknown Ticino text', () => { expect(inferCity('some unknown clinic')).toBe('Lugano'); });
});
