import { describe, expect, it } from 'vitest';

import { buildJobsStatsArtifacts } from '../scripts/lib/job-board-stats.mjs';

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

    expect(summary.links.allJobs).toBe('https://www.frontaliereticino.ch/cerca-lavoro-ticino');
    expect(summary.leaders.topCompaniesActive[0]).toMatchObject({
      name: 'Swisscom (sede Ticino)',
      count: 2,
      url: 'https://www.frontaliereticino.ch/cerca-lavoro-ticino/azienda-swisscom-sede-ticino',
    });
    expect(summary.leaders.topLocationsActive[0]).toMatchObject({
      name: 'Bellinzona',
      count: 2,
      url: 'https://www.frontaliereticino.ch/cerca-lavoro-ticino/ricerca-bellinzona',
    });
    expect(summary.leaders.topCompaniesAddedToday[0]).toMatchObject({
      name: 'Swisscom (sede Ticino)',
      added: 1,
      url: 'https://www.frontaliereticino.ch/cerca-lavoro-ticino/azienda-swisscom-sede-ticino',
    });
    expect(summary.leaders.topTitlesAdded30d[0]).toMatchObject({
      name: 'Network Specialist',
      added: 1,
      url: 'https://www.frontaliereticino.ch/cerca-lavoro-ticino/ricerca-network-specialist',
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
              url: 'https://www.frontaliereticino.ch/cerca-lavoro-ticino/azienda-swisscom-sede-ticino',
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
});
