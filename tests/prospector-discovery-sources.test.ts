import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';
import { careerPagesOnIndexPage, loadCursor, planCommonCrawlPages, sweepSwissCareerPages } from '../scripts/lib/prospector/sources/commoncrawl-careers.mjs';
import { fetchOsmBusinesses } from '../scripts/lib/prospector/sources/osm-overpass.mjs';
import { fetchSecoEmployers } from '../scripts/lib/prospector/sources/seco-jobroom.mjs';

function response(url: string, status: number, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: () => null },
    body: { cancel: async () => {} },
    text: async () => body,
  } as any;
}

const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }];
const sleepImpl = async () => {};

describe('Prospector discovery source outcomes', () => {
  let dir = '';

  beforeEach(() => clearPoliteFetchStateForTests());
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('reports an HTTP failure from SECO instead of returning a healthy empty result', async () => {
    const result = await fetchSecoEmployers({
      cantons: ['TI'],
      fetchImpl: async (url) => response(String(url), 400, 'bad request'),
      lookupImpl,
      sleepImpl,
    });

    expect(result).toMatchObject({ employers: [], outcome: 'unavailable', errorCode: 'http_400', pagesRead: 0 });
  });

  it('retains SECO results while marking a later page failure as partial', async () => {
    let pageCalls = 0;
    const row = {
      jobAdvertisement: {
        jobContent: {
          company: { name: 'Example Sagl', city: 'Lugano' },
          jobDescriptions: [{ title: 'Techniker' }],
        },
      },
    };
    const result = await fetchSecoEmployers({
      cantons: ['TI'],
      pageSize: 1,
      maxPages: 2,
      fetchImpl: async (url) => {
        pageCalls++;
        return pageCalls === 1
          ? response(String(url), 200, JSON.stringify([row]))
          : response(String(url), 503, 'unavailable');
      },
      lookupImpl,
      sleepImpl,
    });

    expect(result).toMatchObject({ outcome: 'partial', errorCode: 'http_503', pagesRead: 1, adCount: 1 });
    expect(result.employers.map(({ name }) => name)).toEqual(['Example Sagl']);
  });

  it('reports malformed Overpass responses instead of disguising them as zero employers', async () => {
    const result = await fetchOsmBusinesses('TI', {
      fetchImpl: async (url) => response(String(url), 200, '{bad json'),
      lookupImpl,
      sleepImpl,
    });

    expect(result).toEqual({ businesses: [], outcome: 'malformed', errorCode: 'malformed_json' });
  });

  it('does not query generic man_made features that include non-employers such as masts', async () => {
    let requestBody = '';
    await fetchOsmBusinesses('TI', {
      fetchImpl: async (url, init) => {
        requestBody = String(init?.body || '');
        return response(String(url), 200, '{"elements":[]}');
      },
      lookupImpl,
      sleepImpl,
    });

    expect(decodeURIComponent(requestBody)).not.toContain('man_made');
  });

  it('marks an Overpass response at its output cap as partial', async () => {
    const elements = ['Alpha AG', 'Beta AG'].map((name) => ({
      tags: { name, website: `https://${name.split(' ')[0].toLowerCase()}-ag.ch` },
    }));
    const result = await fetchOsmBusinesses('TI', {
      limit: 2,
      fetchImpl: async (url) => response(String(url), 200, JSON.stringify({ elements })),
      lookupImpl,
      sleepImpl,
    });

    expect(result).toMatchObject({
      businesses: expect.any(Array),
      outcome: 'partial',
      errorCode: 'result_limit_reached',
    });
    expect(result.businesses).toHaveLength(2);
  });

  it('marks an empty HTTP 200 Common Crawl page malformed instead of checkpointing it', async () => {
    const result = await careerPagesOnIndexPage('CC-MAIN-test', 7, {
      fetchImpl: async (url) => response(String(url), 200, '  \n'),
      lookupImpl,
      sleepImpl,
    });

    expect(result).toEqual({ employers: [], outcome: 'malformed', errorCode: 'empty_index_page' });
  });

  it('sweeps all 1,230 index pages once in 31 batches of 40', () => {
    const cursor: any = { collection: 'CC-MAIN-test', nextPage: 0, totalPages: 0, stride: 0, sweptPages: [], pendingPages: [] };
    const visited = new Set<number>();
    for (let run = 0; run < 31; run++) {
      const plan = planCommonCrawlPages(cursor, 1230, 40);
      for (const page of plan.pages) {
        expect(visited.has(page)).toBe(false);
        visited.add(page);
      }
      cursor.totalPages = 1230;
      cursor.stride = plan.stride;
      cursor.nextPage = plan.nextPage;
      cursor.sweptPages = [...visited];
      cursor.pendingPages = plan.pendingPages;
    }
    expect(visited.size).toBe(1230);
  });

  it('prioritizes retry pages before continuing the index permutation', () => {
    const plan = planCommonCrawlPages({
      collection: 'CC-MAIN-test', nextPage: 9, totalPages: 100, stride: 23,
      sweptPages: [0], pendingPages: [40, 70],
    }, 100, 3);

    expect(plan.pages.slice(0, 2)).toEqual([40, 70]);
    expect(plan.pages).toHaveLength(3);
    expect(plan.pendingPages).toEqual([]);
  });

  it('preserves a malformed Common Crawl cursor instead of resetting coverage', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-commoncrawl-cursor-'));
    const cursorFile = path.join(dir, 'cursor.json');
    fs.writeFileSync(cursorFile, '{bad json', 'utf8');

    expect(() => loadCursor(cursorFile)).toThrow(/Malformed Common Crawl cursor/);
    expect(fs.readFileSync(cursorFile, 'utf8')).toBe('{bad json');
  });

  it('retries a failed Common Crawl page and checkpoints only a complete read', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-commoncrawl-retry-'));
    const cursorFile = path.join(dir, 'cursor.json');
    const healthFile = path.join(dir, 'health.json');
    let pageAvailable = false;
    const fetchImpl = async (input: string | URL) => {
      const url = String(input);
      if (url.includes('showNumPages=true')) return response(url, 200, '{"pages":1}');
      if (!pageAvailable) return response(url, 503, 'temporarily unavailable');
      return response(url, 200, `${JSON.stringify({ url: 'https://example.ch/jobs/careers' })}\n`);
    };
    const options = {
      collection: 'CC-MAIN-test',
      pages: 1,
      persist: true,
      cursorFile,
      healthFile,
      fetchImpl,
      lookupImpl,
      sleepImpl,
    };

    const failed = await sweepSwissCareerPages(options);
    expect(failed).toMatchObject({ outcome: 'unavailable', pagesRead: [], failedPages: [{ page: 0, outcome: 'unavailable' }], coverageRate: 0 });
    expect(loadCursor(cursorFile).sweptPages).toEqual([]);

    pageAvailable = true;
    const recovered = await sweepSwissCareerPages(options);
    expect(recovered).toMatchObject({ outcome: 'complete', pagesRead: [0], failedPages: [], coverageRate: 1 });
    expect(recovered.employers).toEqual([{ host: 'example.ch', url: 'https://example.ch/jobs/careers' }]);
    expect(loadCursor(cursorFile).sweptPages).toEqual([0]);
  });
});
