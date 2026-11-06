import { describe, it, expect } from 'vitest';

/**
 * Verifies that the 4 SEO landing plugins (profession, career, nursing,
 * costOfLiving) use the canonical `renderEmployerCardListHtml` renderer
 * (compact variant) instead of their old inline-style grid cells.
 *
 * Canonical markers emitted by renderEmployerCardListHtml after the
 * Tailwind→CSS-atom refactor (commit 5e715f73e6 — `bg-surface-raised` /
 * `border-edge` were extracted out of the per-card markup into `.ec-cmpct`
 * + `.ec-logoslot` atoms in `index.css`):
 *   - `<ul role="list"` — the list wrapper attribute
 *   - `.ec-cmpct`       — compact card atom (carries border-edge + bg-surface/50)
 *   - `.ec-logoslot`    — logo slot atom (carries bg-surface-raised + border-edge)
 */
const CANONICAL_EMPLOYER_MARKERS = [
  /<ul[^>]+role="list"/,
  /class="ec-cmpct"/,
  /class="ec-logoslot/,
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

describe('weeklyEmployersPlugin uses canonical employer cards (detailed)', () => {
  it('renders detailed-variant employer markup with rank + subtitle + metric tone', async () => {
    const mod: any = await import('../../build-plugins/weeklyEmployersPlugin');
    expect(typeof mod.renderTopCompaniesSectionForTest).toBe('function');
    const html = mod.renderTopCompaniesSectionForTest('it', [
      { employer: 'Lonza', employerKey: 'lonza', active: 35, delta: 3 },
      { employer: 'Migros', employerKey: 'migros', active: 18, delta: 0 },
    ]);
    // Detailed variant emits the `.ec-card` atom (carries rounded-xl +
    // border + border-edge + bg-surface/50 via @apply in index.css).
    expect(html).toMatch(/<article class="ec-card"/);
    expect(html).toContain('Lonza');
    expect(html).toContain('Migros');
    expect(html).toContain('text-success');  // Lonza has positive delta → success tone
    expect(html).toMatch(/<span class="tabular-nums">1\.<\/span>/);  // ranking prefix
  });
});
