import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  dedupeMigrosReposts,
  extractMigrosListingDetailPaths,
  extractMigrosListingPageNumbers,
  fetchMigrosHttpJobDetailUrls,
  migrosListingPageUrl,
} from '../scripts/update-migros-jobs.mjs';

const LISTING_URL =
  'https://jobs.migros.ch/it/le-nostre-imprese/gruppo-migros/posti-di-lavoro-vacanti';
const PAGE_1 = fs.readFileSync(new URL('./fixtures/migros-listing-page-1.html', import.meta.url), 'utf8');
const PAGE_2 = fs.readFileSync(new URL('./fixtures/migros-listing-page-2.html', import.meta.url), 'utf8');

describe('Migros browser-free SSR discovery', () => {
  it('extracts only canonical same-host job paths and page numbers', () => {
    expect(extractMigrosListingDetailPaths(PAGE_1)).toEqual([
      '/de/unsere-unternehmen/job/migros-ticino/verkauf/11111111-1111-4111-8111-111111111111',
      '/it/le-nostre-imprese/job/migros-ticino/vendita/22222222-2222-4222-8222-222222222222',
    ]);
    expect(extractMigrosListingPageNumbers(PAGE_1, LISTING_URL)).toEqual([1, 2]);
    expect(migrosListingPageUrl(LISTING_URL, 2)).toBe(`${LISTING_URL}?page=2`);
  });

  it('fetches every SSR page before finalizing the identity union', async () => {
    const calls: string[] = [];
    const snapshots = new Map([
      [LISTING_URL, PAGE_1],
      [`${LISTING_URL}?page=2`, PAGE_2],
    ]);
    const result = await fetchMigrosHttpJobDetailUrls({
      listingUrl: LISTING_URL,
      maxPages: 2,
      fetchPage: async (url: string) => {
        calls.push(url);
        return snapshots.get(url) || '';
      },
    });

    expect(calls).toEqual([LISTING_URL, `${LISTING_URL}?page=2`]);
    expect(result).toMatchObject({
      termination: 'http-pagination',
      pagesFetched: 2,
      rawUniqueUrls: 3,
      duplicateIdentity: 0,
    });
    expect(result.urls).toEqual([
      'https://jobs.migros.ch/it/le-nostre-imprese/job/migros-ticino/vendita/22222222-2222-4222-8222-222222222222',
      'https://jobs.migros.ch/de/unsere-unternehmen/job/migros-ticino/logistica/44444444-4444-4444-8444-444444444444',
      'https://jobs.migros.ch/de/unsere-unternehmen/job/migros-ticino/verkauf/11111111-1111-4111-8111-111111111111',
    ]);
  });

  it('fails closed when a declared page has no detail links', async () => {
    await expect(fetchMigrosHttpJobDetailUrls({
      listingUrl: LISTING_URL,
      maxPages: 2,
      fetchPage: async (url: string) => url === LISTING_URL ? PAGE_1 : '<html><body>stalled</body></html>',
    })).rejects.toThrow('page 2 has no detail links');
  });

  it('fails closed when the first paginated page has no detail links', async () => {
    const emptyFirstPage = `
      <html><body>
        <a href="${LISTING_URL}?page=1">1</a>
        <a href="${LISTING_URL}?page=2">2</a>
      </body></html>`;

    await expect(fetchMigrosHttpJobDetailUrls({
      listingUrl: LISTING_URL,
      maxPages: 2,
      fetchPage: async () => emptyFirstPage,
    })).rejects.toThrow('first page has no detail links');
  });

  it('accepts an explicit validated zero-result page without pagination', async () => {
    const emptyListing = '<html><body><p>No jobs found.</p></body></html>';
    await expect(fetchMigrosHttpJobDetailUrls({
      listingUrl: LISTING_URL,
      maxPages: 2,
      fetchPage: async () => emptyListing,
    })).resolves.toMatchObject({
      sourceZero: true,
      pagesFetched: 1,
      rawUniqueUrls: 0,
    });
  });

  it('rejects a numbered page that resolves back to page one', async () => {
    await expect(fetchMigrosHttpJobDetailUrls({
      listingUrl: LISTING_URL,
      maxPages: 2,
      fetchPage: async (url: string) => url === LISTING_URL
        ? PAGE_1
        : { body: PAGE_2, status: 200, url: LISTING_URL },
    })).rejects.toThrow('resolved page 2');
  });
});

describe('Migros double publications (audit-parser-quality issue 5253)', () => {
  // Live pair of 2026-09-29: the Gossau SG flower-shop ad published twice under
  // two UUIDs with identical visible text and workplace card.
  const base = 'https://jobs.migros.ch/de/unsere-unternehmen/job/genossenschaft-migros-ostschweiz/fachverkauferin-blumen/';
  const body = 'Hast du ein Auge für Schönheit?\n\n**Luogo di lavoro:** Genossenschaft Migros Ostschweiz, M Gossau, 9200 Gossau SG';
  const daysAgoIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const job = (uuid: string, extra: Record<string, unknown> = {}) => ({
    companyKey: 'migros-ticino',
    url: `${base}${uuid}`,
    title: 'Fachverkäufer*in Blumen',
    location: 'Gossau SG',
    description: body,
    ...extra,
  });

  it('keeps one of two identical postings, preferring the one seen first', () => {
    const other = { companyKey: 'coop-ticino', url: 'https://jobs.coopjobs.ch/x', title: 'Fachverkäufer*in Blumen', location: 'Gossau SG', description: body };
    const { jobs, reposts } = dedupeMigrosReposts([
      job('c922adc5-d69b-4d00-a717-5002ad249e33', { firstSeenAt: daysAgoIso(7) }),
      job('43315b46-0af4-46e8-9361-b737a9683d5d', { firstSeenAt: daysAgoIso(8) }),
      other,
    ], (candidate) => candidate.companyKey === 'migros-ticino');

    expect(jobs.map((kept) => kept.url)).toEqual([`${base}43315b46-0af4-46e8-9361-b737a9683d5d`, other.url]);
    expect(reposts).toEqual([{ url: `${base}c922adc5-d69b-4d00-a717-5002ad249e33`, keptUrl: `${base}43315b46-0af4-46e8-9361-b737a9683d5d` }]);
  });

  it('keeps same-title openings whose published body differs (another store)', () => {
    const { jobs, reposts } = dedupeMigrosReposts([
      job('6742a08c-0d7a-4936-8cae-1ca7cf0c1b00'),
      job('db244148-aa13-400f-a02f-585bb86eadc2', { description: body.replace('M Gossau', 'M Gossau Bahnhof') }),
    ], () => true);

    expect(jobs).toHaveLength(2);
    expect(reposts).toEqual([]);
  });

  it('returns a deduplicated list without the removed repost URL', () => {
    const duplicateUrl = `${base}c922adc5-d69b-4d00-a717-5002ad249e33`;
    const { jobs } = dedupeMigrosReposts([
      job('43315b46-0af4-46e8-9361-b737a9683d5d'),
      job('c922adc5-d69b-4d00-a717-5002ad249e33'),
    ], () => true);

    expect(jobs.map((candidate) => candidate.url)).not.toContain(duplicateUrl);
  });
});
