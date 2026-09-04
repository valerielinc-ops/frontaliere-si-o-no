import { describe, expect, it } from 'vitest';

import {
  buildJobsStatsArtifacts,
  updateJobsStatsHistory,
} from '../scripts/lib/job-board-stats.mjs';

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: String(overrides.id || overrides.slug || 'job-id'),
    slug: String(overrides.slug || overrides.id || 'job-id'),
    url: String(overrides.url || `https://example.com/${overrides.slug || overrides.id || 'job-id'}`),
    title: String(overrides.title || 'Software Engineer'),
    company: String(overrides.company || 'Swisscom (sede Ticino)'),
    companyKey: String(overrides.companyKey || 'swisscom-sede-ticino'),
    location: String(overrides.location || 'Bellinzona'),
    canton: String(overrides.canton || 'TI'),
    description: String(overrides.description || 'Descrizione base'),
    requirements: Array.isArray(overrides.requirements) ? overrides.requirements : [],
    postedDate: String(overrides.postedDate || '2026-03-09'),
    ...overrides,
  };
}

describe('job-board-stats', () => {
  it('collapses duplicate same-date retry entries before building the baseline (#6720)', () => {
    const now = new Date();
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Zurich',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    const baseEntry = {
      date,
      totalJobs: 2,
      added: 1,
      updated: 0,
      removed: 0,
      updatedKeys: [],
      removedKeys: [],
      companyStats: [],
      locationStats: [],
      titleStats: [],
    };
    const history = updateJobsStatsHistory(
      {
        entries: [
          { ...baseEntry, addedKeys: ['url:https://example.com/job-a'] },
          { ...baseEntry, addedKeys: ['url:https://example.com/job-b'] },
        ],
      },
      {},
      [],
      { now: now.toISOString() },
    );

    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({ date, added: 2 });
  });

  it('builds daily history and canonical summary links for current jobs and recent changes', () => {
    const previousJobs = [
      job({
        id: 'job-a',
        slug: 'job-a',
        url: 'https://example.com/job-a',
        title: 'Software Engineer',
        company: 'Swisscom (sede Ticino)',
        companyKey: 'swisscom-sede-ticino',
        location: 'Bellinzona',
        description: 'Versione 1',
      }),
      job({
        id: 'job-b',
        slug: 'job-b',
        url: 'https://example.com/job-b',
        title: 'Private Banker',
        company: 'Banca del Sempione',
        companyKey: 'banca-del-sempione',
        location: 'Lugano',
        description: 'Da rimuovere',
      }),
    ];

    const currentJobs = [
      job({
        id: 'job-a',
        slug: 'job-a',
        url: 'https://example.com/job-a',
        title: 'Software Engineer',
        company: 'Swisscom (sede Ticino)',
        companyKey: 'swisscom-sede-ticino',
        location: 'Bellinzona',
        description: 'Versione 2 aggiornata',
      }),
      job({
        id: 'job-c',
        slug: 'job-c',
        url: 'https://example.com/job-c',
        title: 'Network Specialist',
        company: 'Swisscom (sede Ticino)',
        companyKey: 'swisscom-sede-ticino',
        location: 'Bellinzona',
        description: 'Nuovo annuncio',
      }),
    ];

    const { diff, history, summary } = buildJobsStatsArtifacts({
      previousJobs,
      currentJobs,
      existingHistory: { version: 1, generatedAt: '2026-03-08T18:00:00.000Z', entries: [] },
      now: '2026-03-09T10:15:00.000+01:00',
    });

    expect(diff.addedJobs).toHaveLength(1);
    expect(diff.updatedJobs).toHaveLength(1);
    expect(diff.removedJobs).toHaveLength(1);

    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({
      date: '2026-03-09',
      totalJobs: 2,
      added: 1,
      updated: 1,
      removed: 1,
    });

    expect(summary.totals).toMatchObject({
      activeJobs: 2,
      activeCompanies: 1,
      activeLocations: 1,
      todayAdded: 1,
      todayUpdated: 1,
      todayRemoved: 1,
    });

    expect(summary.history[0]).toEqual({
      date: '2026-03-09',
      totalJobs: 2,
      added: 1,
      updated: 1,
      removed: 1,
    });

    // Aggregate (Switzerland-wide) link, not a single canton's board — see
    // scripts/lib/job-board-stats.mjs JOB_BOARD_AGGREGATE_URL.
    expect(summary.links.allJobs).toBe('https://frontaliereticino.ch/cerca-lavoro-svizzera');
    expect(summary.leaders.topCompaniesActive[0]).toMatchObject({
      name: 'Swisscom (sede Ticino)',
      count: 2,
      url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/azienda-swisscom-sede-ticino',
    });
    expect(summary.leaders.topLocationsActive[0]).toMatchObject({
      name: 'Bellinzona',
      count: 2,
      url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/ricerca-bellinzona',
    });
    expect(summary.leaders.topCompaniesAddedToday[0]).toMatchObject({
      name: 'Swisscom (sede Ticino)',
      added: 1,
      url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/azienda-swisscom-sede-ticino',
    });
    expect(summary.leaders.topTitlesAdded30d[0]).toMatchObject({
      name: 'Network Specialist',
      added: 1,
      url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/ricerca-network-specialist',
    });
    expect(summary.salary.coverage).toMatchObject({
      jobsWithSalary: 0,
      coveragePct: 0,
      avgMid: 0,
      medianMid: 0,
    });
  });

  it('does not double count the same job key twice in the same day', () => {
    const existingHistory = {
      version: 1,
      generatedAt: '2026-03-09T08:00:00.000+01:00',
      entries: [
        {
          date: '2026-03-09',
          totalJobs: 2,
          added: 1,
          updated: 1,
          removed: 0,
          addedKeys: ['url:https://example.com/job-c'],
          updatedKeys: ['url:https://example.com/job-a'],
          removedKeys: [],
          companyStats: [
            {
              key: 'swisscom-sede-ticino',
              name: 'Swisscom (sede Ticino)',
              url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/azienda-swisscom-sede-ticino',
              addedKeys: ['url:https://example.com/job-c'],
              updatedKeys: ['url:https://example.com/job-a'],
              removedKeys: [],
            },
          ],
          locationStats: [],
          titleStats: [],
        },
      ],
    };

    const currentJobs = [
      job({
        id: 'job-a',
        slug: 'job-a',
        url: 'https://example.com/job-a',
        title: 'Software Engineer',
        company: 'Swisscom (sede Ticino)',
        companyKey: 'swisscom-sede-ticino',
        location: 'Bellinzona',
        description: 'Versione 3 aggiornata ancora',
      }),
      job({
        id: 'job-c',
        slug: 'job-c',
        url: 'https://example.com/job-c',
        title: 'Network Specialist',
        company: 'Swisscom (sede Ticino)',
        companyKey: 'swisscom-sede-ticino',
        location: 'Bellinzona',
        description: 'Nuovo annuncio',
      }),
    ];

    const { history, summary } = buildJobsStatsArtifacts({
      previousJobs: [
        job({
          id: 'job-a',
          slug: 'job-a',
          url: 'https://example.com/job-a',
          title: 'Software Engineer',
          company: 'Swisscom (sede Ticino)',
          companyKey: 'swisscom-sede-ticino',
          location: 'Bellinzona',
          description: 'Versione 2 aggiornata',
        }),
        job({
          id: 'job-c',
          slug: 'job-c',
          url: 'https://example.com/job-c',
          title: 'Network Specialist',
          company: 'Swisscom (sede Ticino)',
          companyKey: 'swisscom-sede-ticino',
          location: 'Bellinzona',
          description: 'Nuovo annuncio',
        }),
      ],
      currentJobs,
      existingHistory,
      now: '2026-03-09T18:45:00.000+01:00',
    });

    expect(history.entries[0]).toMatchObject({
      date: '2026-03-09',
      added: 1,
      updated: 1,
      removed: 0,
    });
    expect(history.entries).toHaveLength(1);
    expect(summary.totals.todayUpdated).toBe(1);
  });

  it('treats slug renames on the same source URL as updates instead of add/remove churn', () => {
    const previousJobs = [
      job({
        id: 'job-bi',
        slug: 'bi-specialist-relewant-bellinzona',
        url: 'https://relewant.com/jobs/bi-specialist',
        title: 'BI Specialist',
        titleByLocale: { it: 'BI Specialist' },
        slugByLocale: { it: 'bi-specialist-relewant-bellinzona' },
      }),
    ];

    const currentJobs = [
      job({
        id: 'job-bi',
        slug: 'specialista-della-bi-relewant-bellinzona',
        url: 'https://relewant.com/jobs/bi-specialist',
        title: 'Specialista della BI',
        titleByLocale: { it: 'Specialista della BI' },
        slugByLocale: { it: 'specialista-della-bi-relewant-bellinzona' },
      }),
    ];

    const { diff, history } = buildJobsStatsArtifacts({
      previousJobs,
      currentJobs,
      existingHistory: { version: 1, generatedAt: '2026-03-16T08:00:00.000Z', entries: [] },
      now: '2026-03-17T09:30:00.000+01:00',
    });

    expect(diff.addedJobs).toHaveLength(0);
    expect(diff.removedJobs).toHaveLength(0);
    expect(diff.updatedJobs).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({
      added: 0,
      updated: 1,
      removed: 0,
    });
  });

  it('computes salary observatory leaders from jobs with salary data', () => {
    const currentJobs = [
      job({
        id: 'job-salary-a',
        slug: 'job-salary-a',
        title: 'Payroll Specialist',
        company: 'EFG International',
        companyKey: 'efg',
        location: 'Lugano',
        salaryMin: 90000,
        salaryMax: 120000,
      }),
      job({
        id: 'job-salary-b',
        slug: 'job-salary-b',
        title: 'Payroll Specialist',
        company: 'EFG International',
        companyKey: 'efg',
        location: 'Lugano',
        salaryMin: 100000,
        salaryMax: 130000,
      }),
      job({
        id: 'job-salary-c',
        slug: 'job-salary-c',
        title: 'Compliance Officer',
        company: 'Banca del Sempione',
        companyKey: 'banca-del-sempione',
        location: 'Lugano',
        salaryMin: 80000,
        salaryMax: 110000,
      }),
    ];

    const { summary } = buildJobsStatsArtifacts({
      previousJobs: [],
      currentJobs,
      existingHistory: { version: 1, generatedAt: '2026-03-08T18:00:00.000Z', entries: [] },
      now: '2026-03-09T10:15:00.000+01:00',
    });

    expect(summary.salary.coverage).toMatchObject({
      jobsWithSalary: 3,
      coveragePct: 100,
      avgMin: 90000,
      avgMax: 120000,
      avgMid: 105000,
      medianMid: 105000,
    });
    expect(summary.salary.leaders.topSalaryCompanies[0]).toMatchObject({
      name: 'EFG International',
      count: 2,
      avgMid: 110000,
    });
    expect(summary.salary.leaders.topSalaryLocations[0]).toMatchObject({
      name: 'Lugano',
      count: 3,
      avgMid: 105000,
    });
    expect(summary.salary.leaders.topSalaryTitles[0]).toMatchObject({
      name: 'Payroll Specialist',
      count: 2,
      avgMid: 110000,
    });
  });

  it('slims updatedKeys/removedKeys to counts on past days but keeps them on the current day (file-size ceiling, #1358)', () => {
    // A prior day with many updates whose raw key arrays must be dropped.
    const pastDate = '2026-06-01';
    const updatedKeys = Array.from({ length: 50 }, (_, i) => `url:https://example.com/past-${i}`);
    const removedKeys = Array.from({ length: 10 }, (_, i) => `url:https://example.com/gone-${i}`);
    const existingHistory = {
      version: 1,
      generatedAt: `${pastDate}T08:00:00.000Z`,
      entries: [
        {
          date: pastDate,
          totalJobs: 100,
          added: 5,
          updated: updatedKeys.length,
          removed: removedKeys.length,
          addedKeys: ['url:https://example.com/added-0'],
          updatedKeys,
          removedKeys,
          companyStats: [
            {
              key: 'swisscom-sede-ticino',
              name: 'Swisscom (sede Ticino)',
              url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/azienda-swisscom-sede-ticino',
              addedKeys: ['url:https://example.com/added-0'],
              updatedKeys,
              removedKeys,
            },
          ],
          locationStats: [],
          titleStats: [],
        },
      ],
    };

    const { history } = buildJobsStatsArtifacts({
      previousJobs: [],
      currentJobs: [job({ id: 'job-a', slug: 'job-a' })],
      existingHistory,
      now: '2026-06-09T10:00:00.000+02:00',
    });

    const past = history.entries.find((e) => e.date === pastDate)!;
    const today = history.entries.find((e) => e.date === '2026-06-09')!;

    // Past day: raw updated/removed key arrays dropped, scalar counts preserved.
    expect(past.updatedKeys).toHaveLength(0);
    expect(past.removedKeys).toHaveLength(0);
    expect(past.updated).toBe(50);
    expect(past.removed).toBe(10);
    // addedKeys are kept (needed for added-leader dedup across the window).
    expect(past.addedKeys.length).toBeGreaterThan(0);
    // Bucket-level: arrays slimmed, counts carried.
    const pastCompany = past.companyStats[0];
    expect(pastCompany.updatedKeys).toHaveLength(0);
    expect(pastCompany.removedKeys).toHaveLength(0);
    expect(pastCompany.updatedCount).toBe(50);
    expect(pastCompany.removedCount).toBe(10);

    // Current day: full arrays retained (concurrent same-day pushes dedupe on them).
    expect(Array.isArray(today.addedKeys)).toBe(true);
  });

  it('resolves canton-aware summary links instead of hardcoding the TI job board root', () => {
    const zhJob = job({
      id: 'zh-job',
      slug: 'zh-job',
      canton: 'ZH',
      location: 'Zurich',
      company: 'Google Zurich',
      companyKey: 'google-zurich',
      title: 'Data Engineer',
    });

    const { summary } = buildJobsStatsArtifacts({
      previousJobs: [],
      currentJobs: [zhJob],
      existingHistory: {},
      now: '2026-06-09T10:00:00.000+02:00',
    });

    const company = summary.leaders.topCompaniesActive.find((c) => c.name === 'Google Zurich');
    const location = summary.leaders.topLocationsActive.find((l) => l.name === 'Zurich');
    expect(company?.url).toBe('https://frontaliereticino.ch/cerca-lavoro-zurigo/azienda-google-zurich');
    expect(location?.url).toBe('https://frontaliereticino.ch/cerca-lavoro-zurigo/ricerca-zurich');

    // TI jobs keep the legacy TI section unchanged.
    const { summary: tiSummary } = buildJobsStatsArtifacts({
      previousJobs: [],
      currentJobs: [job({ id: 'ti-job', slug: 'ti-job' })],
      existingHistory: {},
      now: '2026-06-09T10:00:00.000+02:00',
    });
    expect(tiSummary.leaders.topCompaniesActive[0].url).toBe(
      'https://frontaliereticino.ch/cerca-lavoro-ticino/azienda-swisscom-sede-ticino',
    );
  });
});
