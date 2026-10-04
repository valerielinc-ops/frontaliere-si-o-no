import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllAminaBankJobs } from '../scripts/lib/amina-bank-job-parser.mjs';
import { fetchAllKellerhalsCarrardJobs } from '../scripts/lib/kellerhals-carrard-job-parser.mjs';
import { fetchAllLaliveJobs } from '../scripts/lib/lalive-job-parser.mjs';
import { fetchAllSuneEggeJobs } from '../scripts/lib/sune-egge-job-parser.mjs';

afterEach(() => vi.unstubAllGlobals());
const consumers = [
  ['AMINA', 'Switzerland', fetchAllAminaBankJobs],
  ['Kellerhals', 'Zürich', fetchAllKellerhalsCarrardJobs],
  ['LALIVE', 'Geneva (GVA)', fetchAllLaliveJobs],
  ['Sune-Egge', 'Fachspital Sune-Egge', fetchAllSuneEggeJobs],
] as const;
const description = Array(60).fill('Source description retained for professional collaboration').join(' ');

describe.each(consumers)('%s JSON listing and rendered Personio detail provenance', (_name, office, fetchJobs) => {
  it.each(['valid', 'missing', 'invalid', 'future', 'created-only', 'detail-unavailable'])('retains the listing for %s detail publication date', async kind => {
    const past = new Date(Date.now() - 3 * 86400000).toISOString().replace('Z', '+02:00');
    const datePosted = kind === 'valid' ? past : kind === 'future'
      ? new Date(Date.now() + 3 * 86400000).toISOString() : kind === 'invalid' ? 'not-a-date' : undefined;
    const listing = {
      id: '12345', name: 'Professional collaboration specialist', office,
      description, createdAt: past, postedAt: past,
    };
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting', title: listing.name, description, datePosted,
      dateCreated: kind === 'created-only' ? past : undefined,
    })}</script></head><body></body></html>`;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.hostname).toContain('.jobs.personio.');
      if (url.pathname === '/search.json') return new Response(JSON.stringify([listing]), { status: 200 });
      expect(url.pathname).toBe('/job/12345');
      return new Response(kind === 'detail-unavailable' ? '' : html, { status: kind === 'detail-unavailable' ? 404 : 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const jobs = await fetchJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      postedDate: kind === 'valid' ? past : '',
      datePosted: kind === 'valid' ? past : '',
      postingDateSource: kind === 'valid' ? 'reported' : 'unknown',
    });
    expect(jobs[0].description).toContain('Source description retained');
    expect(jobs[0].applyUrl).toContain('/job/12345');
    expect(Number.isFinite(Date.parse(jobs[0].crawledAt))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
