import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeGreenhouseJob, fetchGreenhouseJobs } from '../scripts/lib/ats-clients/greenhouse-client.mjs';
import { normalizePersonioJob, fetchPersonioJobs, withRenderedPersonioPage } from '../scripts/lib/ats-clients/personio-client.mjs';

const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown', postedAt: null };
const validDate = () => new Date(Date.now() - 3 * 86400000).toISOString();
const cases = ['missing', 'invalid', 'impossible', 'future', 'reported'] as const;
function sourceDate(kind: typeof cases[number]) {
  if (kind === 'missing') return '';
  if (kind === 'invalid') return 'invalid';
  if (kind === 'impossible') return `${new Date().getUTCFullYear()}-02-30T10:00:00Z`;
  if (kind === 'future') return new Date(Date.now() + 3600000).toISOString();
  return validDate();
}
const reported = (date: string) => ({ datePosted: date, postedDate: date, postingDateSource: 'reported', postedAt: date });
afterEach(() => vi.unstubAllGlobals());

describe('Greenhouse publication provenance', () => {
  for (const kind of cases) {
    it(`${kind}: normalizes first_published without promoting updated_at`, () => {
      const date = sourceDate(kind);
      const job = normalizeGreenhouseJob({ id: 1, title: 'Engineer', first_published: date, updated_at: validDate() });
      expect(job).toMatchObject(kind === 'reported' ? reported(date) : unknown);
    });
  }
  it('retains explicit publication through the real HTTP client', async () => {
    const date = validDate();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ jobs: [{ id: 1, title: 'Engineer', location: { name: 'Zurich' }, first_published: date, updated_at: new Date().toISOString() }] }), { status: 200 })));
    const jobs = await fetchGreenhouseJobs('fixture');
    expect(jobs[0]).toMatchObject(reported(date));
  });
});

describe('Personio detail publication provenance', () => {
  it('does not promote XML creation before the detail is observed', () => {
    expect(normalizePersonioJob({ id: 1, createdAt: validDate() }, { subdomain: 'fixture' })).toMatchObject(unknown);
  });
  for (const kind of cases) {
    it(`${kind}: uses only detail JobPosting datePosted for both XML and search.json consumers`, async () => {
      const date = sourceDate(kind);
      const createdAt = validDate();
      const fetchMock = vi.fn(async (url) => new Response(String(url).endsWith('/xml')
        ? `<workzag-jobs><position><id>1</id><name>Engineer</name><office>Zurich</office><createdAt>${createdAt}</createdAt></position></workzag-jobs>`
        : `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', datePosted: date, description: 'Source description' })}</script>`, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const jobs = await fetchPersonioJobs('fixture');
      const wrapped = await withRenderedPersonioPage({ id: 1, name: 'Engineer', createdAt, datePosted: createdAt, postingDateSource: 'reported' }, 'https://fixture.jobs.personio.de/job/1');
      const expected = kind === 'reported' ? reported(date) : unknown;
      expect(jobs[0]).toMatchObject(expected);
      expect(wrapped).toMatchObject(expected);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  }
  it('keeps unknown after failed detail even when XML creation is valid', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => String(url).endsWith('/xml')
      ? new Response(`<workzag-jobs><position><id>1</id><createdAt>${validDate()}</createdAt></position></workzag-jobs>`, { status: 200 })
      : new Response('missing', { status: 404 })));
    expect((await fetchPersonioJobs('fixture'))[0]).toMatchObject(unknown);
  });
});
