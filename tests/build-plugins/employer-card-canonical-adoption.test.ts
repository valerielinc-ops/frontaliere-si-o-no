import { describe, it, expect } from 'vitest';

/**
 * Verifies that the 4 SEO landing plugins (profession, career, nursing,
 * costOfLiving) use the canonical `renderEmployerCardListHtml` renderer
 * (compact variant) instead of their old inline-style grid cells.
 *
 * Canonical markers emitted by renderEmployerCardListHtml:
 *   - <ul role="list"   — the list wrapper attribute
 *   - bg-surface-raised — Tailwind token on the logo slot
 *   - border-edge       — Tailwind token on the card border
 */
const CANONICAL_EMPLOYER_MARKERS = [
  /<ul[^>]+role="list"/,
  /bg-surface-raised/,
  /border-edge/,
];

const FIXTURE_SNAPSHOT = {
  topEmployers: [
    { name: 'Migros Ticino', count: 5 },
    { name: 'SUPSI', count: 3 },
    { name: 'Banca Stato', count: 2 },
  ],
};

describe('professionLandingsPlugin uses canonical employer cards', () => {
  it('renders ul role=list with canonical employer markup', async () => {
    const mod: any = await import('../../build-plugins/professionLandingsPlugin');
    expect(typeof mod.renderProfessionEmployerGridForTest).toBe('function');
    const html = mod.renderProfessionEmployerGridForTest('educatore', 'it', FIXTURE_SNAPSHOT);
    for (const m of CANONICAL_EMPLOYER_MARKERS) {
      expect(html, `missing canonical marker ${m}`).toMatch(m);
    }
    expect(html).toContain('Migros Ticino');
    expect(html).toContain('SUPSI');
  });
});

describe('careerLandingsPlugin uses canonical employer cards', () => {
  it('renders canonical employer markup', async () => {
    const mod: any = await import('../../build-plugins/careerLandingsPlugin');
    expect(typeof mod.renderCareerEmployerGridForTest).toBe('function');
    // 'agenzie-lavoro-lugano' is the first id in CAREER_LANDING_IDS
    const html = mod.renderCareerEmployerGridForTest('agenzie-lavoro-lugano', 'it', FIXTURE_SNAPSHOT);
    for (const m of CANONICAL_EMPLOYER_MARKERS) expect(html).toMatch(m);
    expect(html).toContain('Migros Ticino');
  });
});

describe('nursingLandingsPlugin uses canonical employer cards', () => {
  it('renders canonical employer markup', async () => {
    const mod: any = await import('../../build-plugins/nursingLandingsPlugin');
    expect(typeof mod.renderNursingEmployerGridForTest).toBe('function');
    // 'nurses' is the first id in NURSING_LANDING_IDS
    const html = mod.renderNursingEmployerGridForTest('nurses', 'it', FIXTURE_SNAPSHOT);
    for (const m of CANONICAL_EMPLOYER_MARKERS) expect(html).toMatch(m);
    expect(html).toContain('Migros Ticino');
  });
});

describe('costOfLivingLandingsPlugin uses canonical employer cards', () => {
  it('renders canonical employer markup', async () => {
    const mod: any = await import('../../build-plugins/costOfLivingLandingsPlugin');
    expect(typeof mod.renderCostOfLivingEmployerGridForTest).toBe('function');
    // 'lugano' is the first id in COL_CITY_IDS
    const html = mod.renderCostOfLivingEmployerGridForTest('lugano', 'it', FIXTURE_SNAPSHOT);
    for (const m of CANONICAL_EMPLOYER_MARKERS) expect(html).toMatch(m);
    expect(html).toContain('Migros Ticino');
  });
});
