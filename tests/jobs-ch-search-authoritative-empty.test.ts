// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchAllCityPopJobs, CITY_POP_KEY } from '../scripts/lib/city-pop-job-parser.mjs';
import {
  fetchJobsChCompanyListings,
  jobsChAuthoritativeEmptyOrNull,
} from '../scripts/lib/jobs-ch-search-common.mjs';
import { isAuthoritativeEmptySnapshot } from '../scripts/lib/authoritative-empty-snapshot.mjs';
import { evaluateAuthoritativeSnapshot } from '../scripts/lib/crawler-template.mjs';
import { EMPTY_OK_CRAWLERS } from '../scripts/lib/crawler-empty-ok-registry.mjs';
import { nextCrawlerState } from '../scripts/check-crawler-health.mjs';

/**
 * OBSERVER for issue 11653 (`[crawler-health] city-pop`).
 *
 * The jobs.ch company search answers every query with its own count. City Pop
 * had no open posting on 2026-10-05 and the API said so:
 * `{documents: [], numPages: 0, totalHits: 0}`. The crawler nevertheless
 * returned a bare `[]` — the same value a parser that no longer understands the
 * response returns — so the run aborted as `no-jobs-parsed` and the monitor
 * kept the slug `broken`, reopening the issue for a healthy empty employer.
 *
 * Both halves are pinned here:
 *   1. a zero the API DECLARES becomes a source-proven empty snapshot, which
 *      the pipeline publishes and the monitor reads as healthy;
 *   2. an empty result the API did NOT declare (totalHits > 0, a missing
 *      count, listings the parser filtered out) stays a bare `[]`: the
 *      previous slice is kept and the slug stays broken, as before.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CITY_POP_ID = 'eb0155fc-e81e-4f2c-8770-e211d2689811';

// Exact body served live on 2026-10-05 for City Pop (page=1, rows=100).
const LIVE_EMPTY_BODY = {
  rows: 100,
  numPages: 0,
  currentPage: 1,
  documents: [],
  hash: '58c45dd198869fa30721a799db0e6bfd',
  start: 0,
  totalHits: 0,
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubSearch(body: unknown) {
  const requested: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    requested.push(url);
    if (url.startsWith('https://job-search-api.jobs.ch/search')) return jsonResponse(200, body);
    return jsonResponse(404, { message: 'not found' });
  }));
  return requested;
}

/** The pipeline's default verdict for a runner without its own validator (city-pop's). */
function pipelinePublishesProvenZero(jobs: any): boolean {
  return evaluateAuthoritativeSnapshot(jobs, { companyLabel: 'City Pop' }).authoritativeEmptySnapshot;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('jobs.ch company search — declared zero is a proven empty snapshot (issue 11653)', () => {
  it('city-pop publishes a source-proven zero when the API declares totalHits=0', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const requested = stubSearch(LIVE_EMPTY_BODY);

    const jobs = await fetchAllCityPopJobs();

    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain(`companyIds=${CITY_POP_ID}`);
    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);
    expect((jobs as any).authoritativeEmptyEvidence).toContain('totalHits=0');
    expect(pipelinePublishesProvenZero(jobs)).toBe(true);
  });

  it('keeps the bare, unproven [] when the API counts hits but returns no document', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubSearch({ ...LIVE_EMPTY_BODY, numPages: 1, totalHits: 3 });

    const jobs = await fetchAllCityPopJobs();

    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
    expect(pipelinePublishesProvenZero(jobs)).toBe(false);
  });

  it('does not read a missing or renamed count as zero', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { totalHits: _drop, ...withoutCount } = LIVE_EMPTY_BODY;
    stubSearch(withoutCount);
    expect(isAuthoritativeEmptySnapshot(await fetchAllCityPopJobs())).toBe(false);

    stubSearch({ ...LIVE_EMPTY_BODY, totalHits: '0', numPages: '0' });
    expect(isAuthoritativeEmptySnapshot(await fetchAllCityPopJobs())).toBe(false);

    const { documents: _docs, ...withoutDocuments } = LIVE_EMPTY_BODY;
    stubSearch(withoutDocuments);
    expect(isAuthoritativeEmptySnapshot(await fetchAllCityPopJobs())).toBe(false);
  });

  it('does not prove a zero the parser produced by filtering real listings out', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubSearch({ ...LIVE_EMPTY_BODY, numPages: 1, totalHits: 1, documents: [{ id: 'x', title: 'a' }] });

    const listings = await fetchJobsChCompanyListings({ companyIds: [CITY_POP_ID] });
    expect(listings).toHaveLength(1);
    expect(jobsChAuthoritativeEmptyOrNull([], 'City Pop')).toBeNull();
    expect(jobsChAuthoritativeEmptyOrNull(listings, 'City Pop')).toBeNull();

    const jobs = await fetchAllCityPopJobs();
    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('keeps the evidence out of the serialised listings', async () => {
    stubSearch(LIVE_EMPTY_BODY);
    const listings = await fetchJobsChCompanyListings({ companyIds: [CITY_POP_ID] });
    expect(JSON.stringify(listings)).toBe('[]');
    expect(Object.keys(listings)).toEqual([]);
  });
});

describe('crawler-health monitor on the city-pop slug (issue 11653)', () => {
  const NOW_ISO = '2026-10-05T12:00:00.000Z';
  const NOW_MS = Date.parse(NOW_ISO);
  // The broken state on origin/main when the issue was taken.
  const brokenPrev = {
    lastSuccessfulRunAt: '2026-10-02T09:20:19.951Z',
    lastNonZeroJobs: 1,
    consecutiveEmptyRuns: 3,
    status: 'broken',
    advisory: false,
  };
  const observation = (extra: Record<string, unknown>) => ({
    slug: CITY_POP_KEY,
    freshnessAt: NOW_ISO,
    freshnessSource: 'summary',
    jobCount: 0,
    activeJobCount: 0,
    discovered: 0,
    written: 0,
    parsed: 0,
    earlyExit: false,
    exitCode: null,
    ...extra,
  });

  it('turns healthy on a run that publishes the source-proven zero', () => {
    const { state } = nextCrawlerState(
      brokenPrev,
      observation({ authoritativeEmptySnapshot: true }),
      NOW_ISO,
      NOW_MS,
    );
    expect(state.status).toBe('healthy');
  });

  it('stays broken on an unproven zero (the parser bail-out of today)', () => {
    const { state } = nextCrawlerState(
      brokenPrev,
      observation({ authoritativeEmptySnapshot: false, earlyExit: true, abortKind: 'no-jobs-parsed', exitCode: 0 }),
      NOW_ISO,
      NOW_MS,
    );
    expect(state.status).toBe('broken');
  });

  it('is no longer allowlisted: the proof is re-established every run instead', () => {
    expect(EMPTY_OK_CRAWLERS.has(CITY_POP_KEY)).toBe(false);
    const parser = fs.readFileSync(path.join(REPO_ROOT, 'scripts/lib/city-pop-job-parser.mjs'), 'utf8');
    expect(parser).toContain('jobsChAuthoritativeEmptyOrNull(listings,');
  });
});
