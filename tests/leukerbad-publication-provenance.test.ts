import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllLeukerbadClinicJobs } from '../scripts/lib/leukerbad-clinic-job-parser.mjs';

const api = 'https://leukerbad-clinic.cdn.prismic.io/api/v2';
const now = new Date();
const pastDay = new Date(now.getTime() - 3 * 86400000).toISOString().slice(0, 10);
const laterDay = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
const futureDay = new Date(now.getTime() + 3 * 86400000).toISOString().slice(0, 10);
const cases: ReadonlyArray<readonly [string, unknown, string, string]> = [
  ['immutable first publication wins over later republication', `${pastDay}T10:23:45+0200`, `${laterDay}T08:00:00+0000`, `${pastDay}T10:23:45+02:00`],
  ['valid first publication survives invalid last publication', `${pastDay}T07:15:00Z`, 'not-a-date', `${pastDay}T07:15:00Z`],
  ['valid first publication survives future last publication', `${pastDay}T07:15:00Z`, `${futureDay}T00:00:00Z`, `${pastDay}T07:15:00Z`],
  ['missing first publication does not promote a later update', undefined, `${laterDay}T08:00:00Z`, ''],
  ['invalid first publication does not promote a later update', 'invalid', `${laterDay}T08:00:00Z`, ''],
  ['future first publication does not become crawl time', `${futureDay}T08:00:00Z`, `${laterDay}T08:00:00Z`, ''],
  ['invalid calendar does not roll into another month', `${now.getUTCFullYear()}-02-30T08:00:00Z`, '', ''],
  ['non-string values are not coerced into dates', { date: pastDay }, '', ''],
];

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Leukerbad publication provenance through the real Prismic producer', () => {
  it.each(cases)('%s', async (_name, first, last, expected) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const description = 'Nous recherchons une personne pour accompagner les patients en réadaptation, collaborer avec les équipes soignantes et participer aux soins dans notre clinique.';
    const doc = { id: 'public-job', uid: 'infirmiere', type: 'job', lang: 'fr-ch', first_publication_date: first, last_publication_date: last,
      data: { job_title: [{ type: 'heading1', text: 'Infirmière en réadaptation' }], workplace: 'Leukerbad', starting_date: futureDay,
        job_description: [{ type: 'paragraph', text: description }] } };
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      if (url === api) return Response.json({ refs: [{ ref: 'public-ref', isMasterRef: true }] });
      const query = new URL(url).searchParams.get('q');
      if (query?.includes('my.page.uid')) return Response.json({ results: [{ data: { jobs: [{ job: { link_type: 'Document', type: 'job', id: doc.id } }] } }] });
      if (query?.includes('document.type')) return Response.json({ results: [doc], total_pages: 1 });
      throw new Error(`Unexpected request ${url}`);
    }));
    const jobs = await fetchAllLeukerbadClinicJobs();
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(job).toMatchObject({ postedDate: expected, datePosted: expected, postingDateSource: expected ? 'reported' : 'unknown', crawledAt: now.toISOString(), companyKey: 'leukerbad-clinic', canton: 'VS' });
    expect(job.description).toContain(description);
    expect(job.description).toContain(futureDay); // Work start remains content, never publication evidence.
    expect(job.id).toMatch(/^leukerbad-clinic-[a-f0-9]{12}$/);
    expect(job.slug).toBeTruthy();
    expect(job.url).toContain('https://leukerbadclinic.ch/fr/page/jobs/?jobid=');
    expect(job.applyUrl).toBe(job.url);
    expect(requests).toHaveLength(3);
  });
});
