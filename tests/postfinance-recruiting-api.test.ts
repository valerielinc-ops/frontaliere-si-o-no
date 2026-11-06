import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchPostFinanceListingsViaRecruitingApi } from '../scripts/update-postfinance-jobs.mjs';

/**
 * Il filtro brand lato server è quello che la SPA di job.post.ch invia sul sito
 * PostFinance (`brand: 'PostFinance'`). Senza filtro la scansione de_DE è ~245
 * righe / 25 pagine di un feed ordinato per data in modo instabile: il
 * 2026-09-21 la pagina 25 è tornata senza `jobSearchResult` e il 2026-09-23
 * l'ultima pagina conteneva solo id già visti.
 */
type ApiBody = { locale: string; pageNumber: number; brand?: string };

const row = (id: string, brandUrl: string) => ({ response: { id, brandUrl } });

function stubRecruitingApi(respond: (body: ApiBody) => unknown) {
  const bodies: ApiBody[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as ApiBody;
    bodies.push(body);
    return new Response(JSON.stringify(respond(body)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));
  return bodies;
}

describe('PostFinance recruiting API discovery', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('asks the API for the PostFinance brand instead of scanning every Post Group page', async () => {
    const branded = Array.from({ length: 12 }, (_, i) => row(`pf-${i}`, 'PostFinance'));
    const bodies = stubRecruitingApi((body) => ({
      totalJobs: branded.length,
      jobSearchResult: branded.slice(body.pageNumber * 10, body.pageNumber * 10 + 10),
    }));

    const listings = await fetchPostFinanceListingsViaRecruitingApi();

    expect(listings.map((listing: { id: string }) => listing.id)).toEqual(branded.map((r) => r.response.id));
    expect(bodies.map((body) => [body.brand, body.pageNumber])).toEqual([
      ['PostFinance', 0],
      ['PostFinance', 1],
    ]);
  });

  it('keeps the client-side brandUrl check on the filtered result', async () => {
    stubRecruitingApi(() => ({
      totalJobs: 2,
      jobSearchResult: [row('pf-1', 'PostFinance'), row('post-1', 'Post')],
    }));

    const listings = await fetchPostFinanceListingsViaRecruitingApi();

    expect(listings.map((listing: { id: string }) => listing.id)).toEqual(['pf-1']);
  });

  it('falls back to the unfiltered scan when the brand filter matches nothing', async () => {
    const bodies = stubRecruitingApi((body) => (body.brand
      ? { totalJobs: 0, jobSearchResult: [] }
      : { totalJobs: 3, jobSearchResult: [row('pf-1', 'PostFinance'), row('post-1', 'Post'), row('pf-2', 'PostFinance')] }));

    const listings = await fetchPostFinanceListingsViaRecruitingApi();

    expect(listings.map((listing: { id: string }) => listing.id)).toEqual(['pf-1', 'pf-2']);
    expect(bodies.map((body) => body.brand ?? null)).toEqual(['PostFinance', null]);
  });

  it('still fails closed when a filtered page loses the jobSearchResult array', async () => {
    stubRecruitingApi((body) => (body.pageNumber === 0
      ? { totalJobs: 12, jobSearchResult: Array.from({ length: 10 }, (_, i) => row(`pf-${i}`, 'PostFinance')) }
      : { totalJobs: 12 }));

    await expect(fetchPostFinanceListingsViaRecruitingApi())
      .rejects.toThrow('PostFinance API pagination failed at page 1: expected jobSearchResult array.');
  });
});
