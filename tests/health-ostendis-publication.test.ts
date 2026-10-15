import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllAdusKlinikJobs } from '../scripts/lib/adus-klinik-job-parser.mjs';
import { fetchAllSalinaRehaJobs } from '../scripts/lib/salina-reha-job-parser.mjs';
import { fetchAllKsowJobs } from '../scripts/lib/ksow-job-parser.mjs';

const state = vi.hoisted(() => ({ posting: {} as Record<string, unknown> }));
vi.mock('../scripts/lib/ats-clients/playwright-runtime.mjs', () => ({
  createBrowser: vi.fn(async () => ({})),
  createPoliteContext: vi.fn(async () => ({
    newPage: async () => ({
      goto: async () => ({ status: () => 200 }),
      waitForLoadState: async () => {}, waitForSelector: async () => {}, waitForTimeout: async () => {},
      evaluate: async () => [{ title: 'Pflegefachperson', url: 'https://link.ostendis.com/publication/pflege/source-token' }],
      $$eval: async () => [JSON.stringify(state.posting)],
      title: async () => 'Pflegefachperson', close: async () => {},
    }),
  })),
  closeAll: vi.fn(async () => {}),
  AntiBotBlockError: class extends Error {}, NavigationTimeout: class extends Error {},
}));
afterEach(() => vi.unstubAllGlobals());
const description = Array(60).fill('Pflege Betreuung Zusammenarbeit Patienten').join(' ');

function verify(job: { description: string; applyUrl: string; crawledAt: string }, date: string) {
  expect(job).toMatchObject({ postedDate: date, datePosted: date, postingDateSource: date ? 'reported' : 'unknown' });
  expect(job.description).toContain('Pflege Betreuung');
  expect(job.applyUrl).toMatch(/^https:\/\//);
  expect(Number.isFinite(Date.parse(job.crawledAt))).toBe(true);
}

describe('ADUS RSS source publication', () => {
  it.each(['valid', 'missing', 'invalid', 'future'])('preserves the record with %s pubDate', async kind => {
    const timestamp = new Date(Date.now() + (kind === 'future' ? 3 : -3) * 86400000);
    timestamp.setUTCMilliseconds(0);
    const raw = kind === 'missing' ? '' : kind === 'invalid' ? 'not-a-date' : timestamp.toUTCString().replace('GMT', '+0200');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`<rss><channel><item><title>Pflegefachperson</title><link>https://karriere.adus-klinik.ch/jobs/123-pflege</link><description>${description}</description><pubDate>${raw}</pubDate></item></channel></rss>`)));
    const jobs = await fetchAllAdusKlinikJobs();
    expect(jobs).toHaveLength(1);
    const expected = kind === 'valid' ? timestamp.toISOString().replace('.000Z', '+02:00') : '';
    verify(jobs[0], expected);
  });
});

describe.each([['Salina', fetchAllSalinaRehaJobs], ['KSOW shared Ostendis', fetchAllKsowJobs]] as const)('%s publication detail', (_name, fetchJobs) => {
  it.each(['valid', 'missing', 'invalid', 'future', 'expiry-only'])('keeps the record and uses only %s publication evidence', async kind => {
    const past = new Date(Date.now() - 3 * 86400000).toISOString();
    state.posting = {
      '@type': 'JobPosting', title: 'Pflegefachperson', description,
      datePosted: kind === 'valid' ? past : kind === 'invalid' ? 'not-a-date'
        : kind === 'future' ? new Date(Date.now() + 3 * 86400000).toISOString() : undefined,
      validThrough: kind === 'expiry-only' ? past : undefined,
    };
    const jobs = await fetchJobs();
    expect(jobs).toHaveLength(1);
    verify(jobs[0], kind === 'valid' ? past : '');
  });
});
