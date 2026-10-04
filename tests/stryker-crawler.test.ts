import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildJobPostingSchema } from '../build-plugins/shared/jobPostingSchema';
import { fetchAllStrykerJobs } from '../scripts/lib/stryker-job-parser.mjs';

const SOURCE_BODY = [
  'Stryker is looking for a quality engineer to support the Swiss operations.',
  'In this role you coordinate validation activities, investigate deviations,',
  'and work with manufacturing and regulatory teams on continuous improvement.',
  'You bring relevant engineering experience, strong communication skills,',
  'and a structured approach to documentation and problem solving.',
  'The position offers a collaborative environment, professional development,',
  'and the opportunity to contribute to products that improve patient care.',
].join(' ');

const REPLAY = [
  {
    title: 'Senior Quality Engineer',
    externalPath: '/job/Selzach/Senior-Quality-Engineer_R1',
    locationsText: 'Selzach, Switzerland',
    postedOn: 'Posted 2 Days Ago',
    detail: {
      jobPostingInfo: {
        title: 'Senior Quality Engineer',
        location: 'Selzach, Switzerland',
        timeType: 'Full time',
        jobDescription: `<div><h2>About the role</h2><p>${SOURCE_BODY}</p></div>`,
      },
    },
  },
  {
    title: 'Project Manager',
    externalPath: '/job/Selzach/Project-Manager_R2',
    locationsText: 'Selzach, Switzerland',
    postedOn: 'Posted 3 Days Ago',
    detail: {
      jobPostingInfo: {
        title: 'Project Manager',
        location: 'Selzach, Switzerland',
        timeType: 'Full time',
        jobDescription: '<p>Apply now to learn more about this opportunity.</p>',
      },
    },
  },
  {
    title: 'Operations Specialist',
    externalPath: '/job/Selzach/Operations-Specialist_R3',
    locationsText: 'Selzach, Switzerland',
    postedOn: 'Posted 4 Days Ago',
    detail: {
      jobPostingInfo: {
        title: 'Operations Specialist',
        location: 'Selzach, Switzerland',
        timeType: 'Full time',
      },
    },
  },
] as const;

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Stryker crawler source-body acceptance', () => {
  it('publishes only a source-backed body and preserves JobPosting fields across locales', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const href = String(url);
      if (init.method === 'POST' && href.endsWith('/jobs')) {
        const request = JSON.parse(String(init.body || '{}')) as { offset?: number };
        return json({
          total: REPLAY.length,
          jobPostings: request.offset && request.offset > 0 ? [] : REPLAY.map((posting) => ({
            title: posting.title,
            externalPath: posting.externalPath,
            locationsText: posting.locationsText,
            postedOn: posting.postedOn,
            bulletFields: [posting.externalPath.split('_').pop()],
          })),
        });
      }

      const posting = REPLAY.find((candidate) => href.endsWith(candidate.externalPath));
      return posting ? json(posting.detail) : new Response('', { status: 404 });
    }));
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      callback();
      return 0;
    }) as unknown as typeof setTimeout);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const jobs: any[] = await fetchAllStrykerJobs();

    expect(jobs.map((job) => job.title)).toEqual(['Senior Quality Engineer']);
    expect(jobs[0]).toMatchObject({
      company: 'Stryker',
      title: 'Senior Quality Engineer',
      description: expect.stringContaining('Stryker is looking for a quality engineer'),
      location: 'Selzach',
      canton: 'SO',
      addressLocality: 'Selzach',
      addressRegion: 'SO',
      addressCountry: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: expect.any(String),
    });
    expect(jobs[0].description).not.toContain('<p>');
    expect(jobs[0].description).not.toContain('Apply now');
    expect(jobs[0].description.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(50);

    for (const locale of ['it', 'en', 'de', 'fr']) {
      const schema = buildJobPostingSchema(jobs[0], {
        locale,
        url: `https://frontaliereticino.ch/jobs/stryker/${locale}/senior-quality-engineer/`,
        now: new Date(),
      });

      expect(schema).toMatchObject({
        '@type': 'JobPosting',
        title: 'Senior Quality Engineer',
        description: expect.any(String),
        datePosted: expect.any(String),
        employmentType: 'FULL_TIME',
        hiringOrganization: { name: 'Stryker' },
        jobLocation: {
          '@type': 'Place',
          address: {
            '@type': 'PostalAddress',
            streetAddress: expect.any(String),
            postalCode: expect.any(String),
            addressLocality: 'Selzach',
            addressRegion: 'SO',
            addressCountry: 'CH',
          },
        },
        baseSalary: {
          '@type': 'MonetaryAmount',
          currency: 'CHF',
          value: {
            '@type': 'QuantitativeValue',
            minValue: expect.any(Number),
            maxValue: expect.any(Number),
            unitText: 'YEAR',
          },
        },
      });
    }
  }, 20_000);
});
