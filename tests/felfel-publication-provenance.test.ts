import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../scripts/lib/ats-clients/personio-client.mjs', () => ({
  PersonioApiError: class PersonioApiError extends Error {},
  buildPersonioXmlUrl: (subdomain: string) => `https://${subdomain}.jobs.personio.de/xml`,
  fetchPersonioJobs: vi.fn(),
}));

import { fetchAllFelfelJobs } from '../scripts/lib/felfel-job-parser.mjs';
import { fetchPersonioJobs } from '../scripts/lib/ats-clients/personio-client.mjs';

const mockFetchPersonioJobs = vi.mocked(fetchPersonioJobs);
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

describe('FELFEL publication provenance', () => {
  beforeEach(() => mockFetchPersonioJobs.mockReset());

  it('maps an explicit postedAt value only for a genuinely legacy shape', async () => {
    const postedAt = daysAgo(2);
    mockFetchPersonioJobs.mockResolvedValue([{
      id: 'felfel-1', title: 'Engineer', location: 'Zürich', applyUrl: 'https://felfel.jobs.personio.de/job/1',
      descriptionHtml: '<p>Source description retained.</p>', department: '', schedule: 'full-time', seniority: '',
      postedAt, datePosted: '', postedDate: '',
    }] as never);

    const [job] = await fetchAllFelfelJobs();
    expect(job).toMatchObject({ postingDateSource: 'reported', datePosted: postedAt, postedDate: postedAt });
  });

  it('keeps postedAt unknown when the normalized record carries an unknown marker', async () => {
    const postedAt = daysAgo(2);
    mockFetchPersonioJobs.mockResolvedValue([{
      id: 'felfel-2', title: 'Analyst', location: 'Zürich', applyUrl: 'https://felfel.jobs.personio.de/job/2',
      descriptionHtml: '<p>Source description retained.</p>', department: '', schedule: 'full-time', seniority: '',
      postedAt, datePosted: '', postedDate: '', postingDateSource: 'unknown',
    }] as never);

    const [job] = await fetchAllFelfelJobs();
    expect(job).toMatchObject({ postingDateSource: 'unknown', datePosted: '', postedDate: '' });
  });
});
