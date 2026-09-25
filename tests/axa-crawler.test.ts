/**
 * AXA Svizzera crawler slug-disambiguation tests.
 *
 * Regression coverage for the silent slug-collision bug where multiple distinct
 * AXA openings (e.g. several "Consulente Assicurativo" roles published in
 * different Ticino cities) collapse to a single title-only slug under the
 * previous formula `slugify(title)` and get silently removed by the
 * housekeeping dedup pass.
 *
 * Audit reference: /tmp/housekeeping-audit-2026-04-07.md identified 16 silent
 * losses in axa-svizzera over a 30-day window (e.g. the Manno opening
 * 7da4e753-c869-4ef6-afe3-65b2ba0021f1 was repeatedly dropped because it
 * shared slug `consulente-per-la-sicurezza-axa-svizzera-axa` with the Biasca
 * opening 47bd2188-53ff-4ebf-b6d5-e00867e82a24).
 *
 * Each AXA vacancy URL contains a unique UUID under
 * `/posizioni-aperte/{slug}/{uuid}`; the regenerated slug must encode that
 * identity so the slugs remain unique even when title + city are identical.
 */
import { describe, it, expect } from 'vitest';
import {
  buildAxaRegeneratedSlug,
  buildAxaJob,
} from '@/scripts/update-axa-jobs.mjs';

interface AxaRowFixture {
  url: string;
  detailUrl?: string;
  title: string;
  excerpt?: string;
  description?: string;
  metaDescription?: string;
  location?: string;
  address?: string;
  workload?: string;
  applyUrl?: string;
  uuid?: string;
  region?: string;
  lang?: string;
}

const makeRow = (overrides: Partial<AxaRowFixture> = {}): AxaRowFixture => ({
  url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/59bcbcc4-45fa-4c1c-9220-afea3c50c8df',
  detailUrl:
    'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/59bcbcc4-45fa-4c1c-9220-afea3c50c8df',
  title: 'Consulente Assicurativo',
  excerpt:
    'AXA cerca un consulente assicurativo motivato per consolidare la propria presenza ' +
    'sul territorio ticinese. Offriamo un ambiente dinamico, formazione continua e ' +
    'percorsi di carriera strutturati nel settore assicurativo svizzero.',
  description:
    'AXA cerca un consulente assicurativo motivato per consolidare la propria presenza ' +
    'sul territorio ticinese. Offriamo un ambiente dinamico, formazione continua e ' +
    'percorsi di carriera strutturati nel settore assicurativo svizzero.',
  metaDescription: '',
  location: 'Lugano',
  address: 'Via Maraini 13, 6900 Lugano',
  workload: '100%',
  applyUrl: 'https://jobs.axa.ch/apply/ats/59bcbcc4-45fa-4c1c-9220-afea3c50c8df',
  uuid: '59bcbcc4-45fa-4c1c-9220-afea3c50c8df',
  region: 'tessin',
  lang: 'it',
  ...overrides,
});

describe('buildAxaRegeneratedSlug — disambiguator', () => {
  it('produces distinct slugs for jobs with identical title + city but different UUIDs', () => {
    const jobA = makeRow({
      url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/7da4e753-c869-4ef6-afe3-65b2ba0021f1',
      location: 'Manno',
    });
    const jobB = makeRow({
      url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/47bd2188-53ff-4ebf-b6d5-e00867e82a24',
      location: 'Biasca',
    });
    const jobC = makeRow({
      url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/59bcbcc4-45fa-4c1c-9220-afea3c50c8df',
      location: 'Lugano',
    });

    const slugA = buildAxaRegeneratedSlug(jobA, jobA.location);
    const slugB = buildAxaRegeneratedSlug(jobB, jobB.location);
    const slugC = buildAxaRegeneratedSlug(jobC, jobC.location);

    expect(slugA).toBeTruthy();
    expect(slugB).toBeTruthy();
    expect(slugC).toBeTruthy();
    expect(new Set([slugA, slugB, slugC]).size).toBe(3);
  });

  it('produces distinct slugs for jobs at the same city with same title but different UUIDs', () => {
    // Two openings published at the same city should still survive dedup.
    const jobA = makeRow({
      url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      location: 'Lugano',
    });
    const jobB = makeRow({
      url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      location: 'Lugano',
    });

    const slugA = buildAxaRegeneratedSlug(jobA, jobA.location);
    const slugB = buildAxaRegeneratedSlug(jobB, jobB.location);

    expect(slugA).not.toBe(slugB);
  });

  it('is deterministic — same job always produces the same slug', () => {
    const job = makeRow({
      url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/59bcbcc4-45fa-4c1c-9220-afea3c50c8df',
      location: 'Lugano',
    });
    const slug1 = buildAxaRegeneratedSlug(job, job.location);
    const slug2 = buildAxaRegeneratedSlug(job, job.location);
    expect(slug1).toBe(slug2);
  });

  it('produces a slug that contains the title tokens, the AXA brand and the city', () => {
    const job = makeRow({
      title: 'Consulente Assicurativo',
      location: 'Lugano',
      url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/59bcbcc4-45fa-4c1c-9220-afea3c50c8df',
    });
    const slug = buildAxaRegeneratedSlug(job, job.location);
    expect(slug).toContain('consulente');
    expect(slug).toContain('axa');
    expect(slug).toContain('lugano');
  });

  it('keeps the slug length within the 90-char SEO cap', () => {
    const job = makeRow({
      title:
        'Consulente Assicurativo Senior Specializzato nei Rami Generali per il Territorio Ticinese',
      location: 'Lugano',
    });
    const slug = buildAxaRegeneratedSlug(job, job.location);
    expect(slug.length).toBeLessThanOrEqual(90);
  });
});

describe('buildAxaJob — slug regression', () => {
  it('produces 3 distinct slugs for 3 jobs with identical title + different UUIDs (audit case)', () => {
    // Reproduces the exact audit scenario from /tmp/housekeeping-audit-2026-04-07.md:
    // 3 "Consulente Assicurativo" openings at different Ticino cities silently
    // collapsed to one slug because the previous formula was `slugify(title)`.
    const rowA = makeRow({
      url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/7da4e753-c869-4ef6-afe3-65b2ba0021f1',
      detailUrl:
        'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/7da4e753-c869-4ef6-afe3-65b2ba0021f1',
      location: 'Manno',
      address: 'Via Industria 5, 6928 Manno',
    });
    const rowB = makeRow({
      url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/47bd2188-53ff-4ebf-b6d5-e00867e82a24',
      detailUrl:
        'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/47bd2188-53ff-4ebf-b6d5-e00867e82a24',
      location: 'Biasca',
      address: 'Via Bellinzona 10, 6710 Biasca',
    });
    const rowC = makeRow({
      url: 'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/59bcbcc4-45fa-4c1c-9220-afea3c50c8df',
      detailUrl:
        'https://jobs.axa.ch/posizioni-aperte/consulente-assicurativo/59bcbcc4-45fa-4c1c-9220-afea3c50c8df',
      location: 'Lugano',
      address: 'Via Maraini 13, 6900 Lugano',
    });

    const jobA = buildAxaJob(rowA);
    const jobB = buildAxaJob(rowB);
    const jobC = buildAxaJob(rowC);

    const slugs = [jobA.slug, jobB.slug, jobC.slug];
    expect(new Set(slugs).size).toBe(3);
  });

  it('sets addressLocality to the per-job city so COMPANY_DEFAULTS does not overwrite it', () => {
    // The Lidl trap: if buildAxaJob does not set addressLocality, applyCompanyDefaults
    // fills it with the hardcoded HQ city, then hardenJobLocaleFields re-derives the
    // slug from `[title, company, addressLocality]` and collapses every per-city slug.
    const row = makeRow({
      location: 'Manno',
      address: 'Via Industria 5, 6928 Manno',
    });
    const job = buildAxaJob(row);
    expect(job.addressLocality).toBeTruthy();
    expect(String(job.addressLocality).toLowerCase()).toContain('manno');
  });
});
