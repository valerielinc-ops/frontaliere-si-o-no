// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchGreenhouseJobs } = vi.hoisted(() => ({
  fetchGreenhouseJobs: vi.fn(),
}));

vi.mock('../scripts/lib/ats-clients/greenhouse-client.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/ats-clients/greenhouse-client.mjs')>()),
  extractGreenhouseBoardToken: () => 'proton',
  fetchGreenhouseJobs,
}));

import { fetchAllProtonJobs } from '../scripts/lib/proton-job-parser.mjs';
import { nextCrawlerState } from '../scripts/check-crawler-health.mjs';

const NOW_MS = Date.now();
const NOW_ISO = new Date(NOW_MS).toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW_MS - days * DAY_MS).toISOString();

const DESCRIPTION = '<p>Build reliable privacy tools with a collaborative engineering team.</p>';

const listing = (location: string, id: number) => ({
  title: `Security Engineer ${id}`,
  location,
  applyUrl: `https://job-boards.eu.greenhouse.io/proton/jobs/${id}`,
  descriptionHtml: DESCRIPTION,
});

const previousHealthyState = {
  lastSuccessfulRunAt: ago(1),
  lastNonZeroJobs: 1,
  consecutiveEmptyRuns: 2,
  consecutiveEmptyOkRuns: 0,
  lastFailureReason: null,
  status: 'healthy',
  _lastObservedAt: ago(1),
  _lastObservedFreshnessAt: ago(1),
  _lastObservedJobs: 1,
  _lastObservedEmptyOk: false,
  _lastObservedAssembledAt: ago(1),
};

describe('Proton snapshot provenance observer', () => {
  beforeEach(() => {
    fetchGreenhouseJobs.mockReset();
  });

  it('keeps an incomplete or ambiguous source snapshot out of a healthy verdict', async () => {
    fetchGreenhouseJobs.mockResolvedValue([
      listing('Geneva, Switzerland, Zürich, Switzerland', 1),
      listing('', 2),
      listing('Geneva, Switzerland, Unknown Satellite Office', 3),
    ]);

    const jobs = await fetchAllProtonJobs();
    expect(jobs).toEqual([]);

    const transition = nextCrawlerState(
      previousHealthyState,
      {
        slug: 'proton',
        freshnessAt: NOW_ISO,
        freshnessSource: 'summary',
        assembledAt: NOW_ISO,
        jobCount: jobs.length,
        activeJobCount: jobs.length,
        discovered: 3,
        parsed: jobs.length,
        written: 0,
        authoritativeEmpty: false,
        earlyExit: true,
        exitCode: 0,
        lastFetchOutcome: 'selector_miss',
        abortKind: 'source-extraction-failed',
      },
      NOW_ISO,
      NOW_MS,
    );

    expect(transition.status).toBe('broken');
    expect(transition.status === 'healthy' && transition.state.advisory === false).toBe(false);
  });

  it('accepts healthy advisory=false only after source-backed Proton evidence survives parsing', async () => {
    fetchGreenhouseJobs.mockResolvedValue([listing('Geneva, Switzerland', 4)]);

    const jobs = await fetchAllProtonJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ location: 'Geneva', canton: 'GE' });

    const transition = nextCrawlerState(
      undefined,
      {
        slug: 'proton',
        freshnessAt: NOW_ISO,
        freshnessSource: 'summary',
        assembledAt: NOW_ISO,
        jobCount: jobs.length,
        activeJobCount: jobs.length,
        discovered: 1,
        parsed: jobs.length,
        written: jobs.length,
        authoritativeEmpty: false,
        earlyExit: false,
        exitCode: null,
        lastFetchOutcome: 'ok',
        abortKind: null,
      },
      NOW_ISO,
      NOW_MS,
    );

    expect(transition).toMatchObject({
      status: 'healthy',
      state: { advisory: false, advisoryReason: null },
      reason: null,
    });
  });
});
