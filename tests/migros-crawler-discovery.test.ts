import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
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
});
