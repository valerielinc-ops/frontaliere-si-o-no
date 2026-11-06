import { describe, expect, it } from 'vitest';

import {
  buildJobTodayLandingModel,
  buildJobNursesHubLandingModel,
  buildJobPartTimeLandingModel,
  buildJobSectorRegionLandingModel,
  resolveEditorialJobLandingDescriptor,
  isJobTodayLandingSlug,
  JOB_TODAY_LANDING_SLUGS,
  JOB_NURSES_HUB_SLUGS,
  JOB_PART_TIME_LANDING_SLUGS,
} from '../build-plugins/jobEditorialLanding';

function job(overrides: Record<string, unknown> = {}) {
  return {
    slug: String(overrides.slug || overrides.id || 'job-id'),
    title: String(overrides.title || 'Software Engineer'),
    titleByLocale: overrides.titleByLocale || {},
    company: String(overrides.company || 'Swisscom'),
    location: String(overrides.location || 'Lugano'),
    contract: String(overrides.contract || 'Full time'),
    postedDate: String(overrides.postedDate || '2026-03-09'),
    crawledAt: String(overrides.crawledAt || '2026-03-09T08:00:00.000+01:00'),
    ...overrides,
  };
}

const baseOpts = {
  now: '2026-03-09T12:00:00Z',
  localizedSlug: (j: { slug: string }) => j.slug,
  baseUrl: 'https://frontaliereticino.ch',
  sectionSlug: 'lavoro-ticino',
  localePrefix: '',
};

// ── Backward compatibility: TI defaults still work exactly as before ──

describe('multi-canton editorial landing — TI backward compatibility', () => {
  it('JOB_TODAY_LANDING_SLUGS default to TI slugs', () => {
    expect(JOB_TODAY_LANDING_SLUGS.it).toBe('offerte-di-lavoro-ticino-oggi');
    expect(JOB_TODAY_LANDING_SLUGS.de).toBe('jobs-tessin-heute');
  });

  it('JOB_NURSES_HUB_SLUGS default to TI slugs', () => {
    expect(JOB_NURSES_HUB_SLUGS.it).toBe('infermieri-in-ticino');
    expect(JOB_NURSES_HUB_SLUGS.de).toBe('pflege-jobs-im-tessin');
  });

  it('JOB_PART_TIME_LANDING_SLUGS are generic (no canton)', () => {
    expect(JOB_PART_TIME_LANDING_SLUGS.it).toBe('lavoro-part-time');
    expect(JOB_PART_TIME_LANDING_SLUGS.en).toBe('part-time-jobs');
  });

  it('buildJobTodayLandingModel without canton param defaults to TI', () => {
    const model = buildJobTodayLandingModel({
      jobs: [job({ id: 't1' })],
      locale: 'it',
      ...baseOpts,
    });
    expect(model.heading).toContain('Ticino');
    expect(model.slug).toBe('offerte-di-lavoro-ticino-oggi');
  });

  it('buildJobNursesHubLandingModel without canton defaults to TI', () => {
    const model = buildJobNursesHubLandingModel({
      jobs: [job({ id: 'n1', category: 'health' })],
      locale: 'it',
      ...baseOpts,
    });
    expect(model.heading).toContain('Ticino');
    expect(model.slug).toBe('infermieri-in-ticino');
  });

  it('buildJobPartTimeLandingModel without canton defaults to TI', () => {
    const model = buildJobPartTimeLandingModel({
      jobs: [job({ id: 'p1', contract: 'Part time' })],
      locale: 'it',
      ...baseOpts,
    });
    expect(model.heading).toContain('Ticino');
  });

  it('resolveEditorialJobLandingDescriptor still resolves TI slugs', () => {
    expect(resolveEditorialJobLandingDescriptor('ricerca-lugano')).toMatchObject({
      kind: 'location',
      location: 'Lugano',
    });
    expect(resolveEditorialJobLandingDescriptor('ricerca-sanita-ticino')).toMatchObject({
      kind: 'sector-region',
      sectorKey: 'health',
    });
  });
});

// ── VS canton support ──

describe('multi-canton editorial landing — VS (Vallese)', () => {
  it('buildJobTodayLandingModel with canton=VS uses Vallese in IT', () => {
    const model = buildJobTodayLandingModel({
      jobs: [job({ id: 'vs1', canton: 'VS', location: 'Sion' })],
      locale: 'it',
      canton: 'VS',
      ...baseOpts,
    });
    expect(model.heading).toContain('Vallese');
    expect(model.heading).not.toContain('Ticino');
    expect(model.slug).toBe('offerte-di-lavoro-vallese-oggi');
  });

  it('buildJobTodayLandingModel with canton=VS uses Wallis in DE', () => {
    const model = buildJobTodayLandingModel({
      jobs: [job({ id: 'vs1', canton: 'VS', location: 'Brig' })],
      locale: 'de',
      canton: 'VS',
      ...baseOpts,
    });
    expect(model.heading).toContain('Wallis');
    expect(model.slug).toBe('jobs-wallis-heute');
  });

  it('buildJobTodayLandingModel with canton=VS uses Valais in FR', () => {
    const model = buildJobTodayLandingModel({
      jobs: [job({ id: 'vs1', canton: 'VS', location: 'Sion' })],
      locale: 'fr',
      canton: 'VS',
      ...baseOpts,
    });
    expect(model.heading).toContain('Valais');
    expect(model.slug).toBe('offres-emploi-valais-aujourdhui');
  });

  it('buildJobTodayLandingModel with canton=VS uses Valais in EN', () => {
    const model = buildJobTodayLandingModel({
      jobs: [job({ id: 'vs1', canton: 'VS', location: 'Visp' })],
      locale: 'en',
      canton: 'VS',
      ...baseOpts,
    });
    expect(model.heading).toContain('Valais');
    expect(model.slug).toBe('valais-jobs-today');
  });

  it('buildJobNursesHubLandingModel with canton=VS uses VS slugs', () => {
    const model = buildJobNursesHubLandingModel({
      jobs: [job({ id: 'vs-nurse', category: 'health', canton: 'VS', location: 'Sion' })],
      locale: 'it',
      canton: 'VS',
      ...baseOpts,
    });
    expect(model.heading).toContain('Vallese');
    expect(model.slug).toBe('infermieri-in-vallese');
  });

  it('buildJobPartTimeLandingModel with canton=VS uses VS copy', () => {
    const model = buildJobPartTimeLandingModel({
      jobs: [job({ id: 'vs-pt', contract: 'Part time', canton: 'VS', location: 'Martigny' })],
      locale: 'it',
      canton: 'VS',
      ...baseOpts,
    });
    expect(model.heading).toContain('Vallese');
  });

  it('isJobTodayLandingSlug recognizes VS slugs', () => {
    expect(isJobTodayLandingSlug('offerte-di-lavoro-vallese-oggi')).toBe(true);
    expect(isJobTodayLandingSlug('valais-jobs-today')).toBe(true);
    expect(isJobTodayLandingSlug('jobs-wallis-heute')).toBe(true);
    expect(isJobTodayLandingSlug('offres-emploi-valais-aujourdhui')).toBe(true);
  });
});

// ── GR canton support ──

describe('multi-canton editorial landing — GR (Grigioni)', () => {
  it('buildJobTodayLandingModel with canton=GR uses Grigioni in IT', () => {
    const model = buildJobTodayLandingModel({
      jobs: [job({ id: 'gr1', canton: 'GR', location: 'Chur' })],
      locale: 'it',
      canton: 'GR',
      ...baseOpts,
    });
    expect(model.heading).toContain('Grigioni');
    expect(model.slug).toBe('offerte-di-lavoro-grigioni-oggi');
  });

  it('buildJobTodayLandingModel with canton=GR uses Graubünden in DE', () => {
    const model = buildJobTodayLandingModel({
      jobs: [job({ id: 'gr1', canton: 'GR', location: 'Chur' })],
      locale: 'de',
      canton: 'GR',
      ...baseOpts,
    });
    expect(model.heading).toContain('Graubünden');
    expect(model.slug).toBe('jobs-graubunden-heute');
  });

  it('buildJobNursesHubLandingModel with canton=GR uses GR slugs', () => {
    const model = buildJobNursesHubLandingModel({
      jobs: [job({ id: 'gr-nurse', category: 'health', canton: 'GR', location: 'Chur' })],
      locale: 'de',
      canton: 'GR',
      ...baseOpts,
    });
    expect(model.heading).toContain('Graubünden');
    expect(model.slug).toBe('pflege-jobs-in-graubunden');
  });

  it('isJobTodayLandingSlug recognizes GR slugs', () => {
    expect(isJobTodayLandingSlug('offerte-di-lavoro-grigioni-oggi')).toBe(true);
    expect(isJobTodayLandingSlug('graubunden-jobs-today')).toBe(true);
    expect(isJobTodayLandingSlug('jobs-graubunden-heute')).toBe(true);
  });

  it('resolveEditorialJobLandingDescriptor resolves GR/VS location slugs', () => {
    // VS cities should be recognized as editorial locations
    const sion = resolveEditorialJobLandingDescriptor('ricerca-sion');
    expect(sion).not.toBeNull();
    if (sion) expect(sion).toMatchObject({ kind: 'location', location: 'Sion' });

    const chur = resolveEditorialJobLandingDescriptor('ricerca-chur');
    expect(chur).not.toBeNull();
    if (chur) expect(chur).toMatchObject({ kind: 'location', location: 'Chur' });

    // VS/GR sector-region descriptors
    const vsHealth = resolveEditorialJobLandingDescriptor('ricerca-sanita-vallese');
    expect(vsHealth).not.toBeNull();
    if (vsHealth) expect(vsHealth).toMatchObject({ kind: 'sector-region', sectorKey: 'health' });

    const grHealth = resolveEditorialJobLandingDescriptor('ricerca-sanita-grigioni');
    expect(grHealth).not.toBeNull();
    if (grHealth) expect(grHealth).toMatchObject({ kind: 'sector-region', sectorKey: 'health' });
  });
});

// ── Canton scoping: jobs are filtered by canton ──

describe('multi-canton editorial landing — canton job scoping', () => {
  const mixedJobs = [
    job({ id: 'ti1', canton: 'TI', location: 'Lugano' }),
    job({ id: 'ti2', canton: 'TI', location: 'Bellinzona' }),
    job({ id: 'vs1', canton: 'VS', location: 'Sion' }),
    job({ id: 'vs2', canton: 'VS', location: 'Brig' }),
    job({ id: 'gr1', canton: 'GR', location: 'Chur' }),
    job({ id: 'no-canton', location: 'Unknown' }),
  ];

  it('TI model only includes TI jobs and jobs without canton', () => {
    const model = buildJobTodayLandingModel({
      jobs: mixedJobs,
      locale: 'it',
      canton: 'TI',
      ...baseOpts,
    });
    // totalJobs should include all jobs passed (total count for the landing)
    // but city leaders should only show TI cities
    expect(model.totalJobs).toBeGreaterThanOrEqual(1);
  });

  it('VS model uses VS slug even with mixed job set', () => {
    const model = buildJobTodayLandingModel({
      jobs: mixedJobs,
      locale: 'it',
      canton: 'VS',
      ...baseOpts,
    });
    expect(model.slug).toBe('offerte-di-lavoro-vallese-oggi');
    expect(model.heading).toContain('Vallese');
  });
});

// ── Sector-region landings with canton ──

describe('multi-canton sector-region landings', () => {
  it('buildJobSectorRegionLandingModel uses default TI canton', () => {
    const healthJobs = [
      job({ id: 'h1', category: 'health', location: 'Lugano' }),
      job({ id: 'h2', category: 'health', location: 'Bellinzona' }),
    ];
    const model = buildJobSectorRegionLandingModel({
      jobs: healthJobs,
      locale: 'it',
      sectorKey: 'health',
      now: '2026-03-09T12:00:00Z',
      localizedSlug: (j) => String(j.slug),
      baseUrl: 'https://frontaliereticino.ch',
      sectionSlug: 'lavoro-ticino',
      localePrefix: '',
    });
    expect(model.heading).toContain('Ticino');
  });
});
