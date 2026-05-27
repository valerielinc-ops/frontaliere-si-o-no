import { describe, it, expect } from 'vitest';

// Post 5e715f73e6 Tailwind→CSS-atom refactor: the literal utility strings
// (`rounded-xl border p-3 sm:p-4`, `w-10 h-10 sm:w-14 sm:h-14 rounded-lg`)
// moved into `.jc-card` + `.jc-logoslot` atoms in `index.css`. The atoms
// `@apply` the same tokens so the rendered styling is unchanged; the
// per-card HTML now only carries the atom class name.
const CANONICAL_MARKERS = [
  /<article class="jc-card/,
  /<div class="jc-logoslot/,
  /class="lucide lucide-map-pin/,
  /data-posted="/,
];

// A realistic FeaturedJob fixture — fields match the extended shape from Task 5.
const FIXTURE_JOB = {
  id: 'job-1',
  title: 'Educatore prima infanzia',
  titleByLocale: { it: 'Educatore prima infanzia' },
  company: 'Asilo Sole',
  companyKey: 'asilo-sole',
  companyDomain: 'asilosole.ch',
  city: 'Lugano',
  addressLocality: 'Lugano',
  canton: 'TI',
  contract: 'full-time',
  salaryMin: 60000,
  salaryMax: 75000,
  postedDate: new Date(Date.now() - 86400000 * 2).toISOString(),
  daysAgo: 2,
  slug: 'educatore-prima-infanzia-asilo-sole-lugano',
  slugByLocale: {},
  employmentType: 'full-time',
  url: 'https://example.com/job-1',
  // CityFeaturedJob also has this field
  isCantonalFallback: false,
};

const EMPTY_SNAPSHOT_BASE = {
  liveCount: 47,
  fresh30Count: 12,
  medianSalaryChf: 65000,
  topEmployers: [],
};

describe('professionLandingsPlugin uses canonical job cards', () => {
  it('emits canonical markers for the educatore landing', async () => {
    const mod: any = await import('../../build-plugins/professionLandingsPlugin');
    expect(typeof mod.renderProfessionFeaturedJobsForTest).toBe('function');
    const html = mod.renderProfessionFeaturedJobsForTest('educatore', 'it', {
      ...EMPTY_SNAPSHOT_BASE,
      featured: [FIXTURE_JOB],
    });
    for (const m of CANONICAL_MARKERS) {
      expect(html, `missing canonical marker ${m}`).toMatch(m);
    }
  });
});

describe('careerLandingsPlugin uses canonical job cards', () => {
  it('emits canonical markers', async () => {
    const mod: any = await import('../../build-plugins/careerLandingsPlugin');
    expect(typeof mod.renderCareerFeaturedJobsForTest).toBe('function');
    const html = mod.renderCareerFeaturedJobsForTest('agenzie-lavoro-lugano', 'it', {
      ...EMPTY_SNAPSHOT_BASE,
      featured: [FIXTURE_JOB],
      topCities: [],
    });
    for (const m of CANONICAL_MARKERS) {
      expect(html, `missing canonical marker ${m}`).toMatch(m);
    }
  });
});

describe('nursingLandingsPlugin uses canonical job cards', () => {
  it('emits canonical markers', async () => {
    const mod: any = await import('../../build-plugins/nursingLandingsPlugin');
    expect(typeof mod.renderNursingFeaturedJobsForTest).toBe('function');
    const html = mod.renderNursingFeaturedJobsForTest('nurses', 'it', {
      ...EMPTY_SNAPSHOT_BASE,
      featured: [FIXTURE_JOB],
    });
    for (const m of CANONICAL_MARKERS) {
      expect(html, `missing canonical marker ${m}`).toMatch(m);
    }
  });
});

describe('costOfLivingLandingsPlugin uses canonical job cards', () => {
  it('emits canonical markers', async () => {
    const mod: any = await import('../../build-plugins/costOfLivingLandingsPlugin');
    expect(typeof mod.renderCostOfLivingFeaturedJobsForTest).toBe('function');
    const html = mod.renderCostOfLivingFeaturedJobsForTest('lugano', 'it', {
      ...EMPTY_SNAPSHOT_BASE,
      featured: [FIXTURE_JOB],
    });
    for (const m of CANONICAL_MARKERS) {
      expect(html, `missing canonical marker ${m}`).toMatch(m);
    }
  });
});
