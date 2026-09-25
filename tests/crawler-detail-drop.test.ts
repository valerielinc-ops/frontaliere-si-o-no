// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  DETAIL_DROP_ADVISORY_RATIO,
  detailDropAdvisoryReason,
  detailDropFromSummary,
  detailDropSummaryFields,
} from '../scripts/lib/crawler-detail-drop.mjs';
import { nextCrawlerState } from '../scripts/check-crawler-health.mjs';

const NOW_ISO = '2026-09-12T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

const observation = (detailDrop: unknown) => ({
  slug: 'jumbo',
  freshnessAt: NOW_ISO,
  freshnessSource: 'summary',
  jobCount: 60,
  activeJobCount: 60,
  discovered: 80,
  written: 60,
  parsed: 80,
  detailDrop,
  authoritativeEmpty: false,
  earlyExit: false,
  exitCode: null,
});

describe('Coop detail-drop summary channel', () => {
  it('writes and reads the gone/rejected counts without inventing a zero', () => {
    const fields = detailDropSummaryFields({ candidates: 80, gone: 14, rejected: 6 });

    expect(fields).toEqual({ detailCandidates: 80, detailGone: 14, detailRejected: 6 });
    expect(detailDropFromSummary(fields)).toEqual({
      candidates: 80,
      gone: 14,
      rejected: 6,
      dropped: 20,
    });
    expect(detailDropSummaryFields(null)).toEqual({});
    expect(detailDropSummaryFields({ candidates: null, gone: null, rejected: null })).toEqual({});
  });

  it('raises an advisory while keeping crawler status healthy', () => {
    const drop = { candidates: 80, gone: 14, rejected: 6 };
    const state = nextCrawlerState(
      { status: 'healthy', consecutiveEmptyRuns: 0 },
      observation(drop),
      NOW_ISO,
      NOW_MS,
    ).state;

    expect(detailDropAdvisoryReason(drop)).toContain('20/80');
    expect(state.advisory).toBe(true);
    expect(state.status).toBe('healthy');
    expect(DETAIL_DROP_ADVISORY_RATIO).toBeLessThan(0.5);
  });

  it('does not flag an uninstrumented or low-drop summary', () => {
    const quiet = nextCrawlerState(
      { status: 'healthy', consecutiveEmptyRuns: 0 },
      observation({ candidates: 80, gone: 3, rejected: 1 }),
      NOW_ISO,
      NOW_MS,
    ).state;
    const uninstrumented = nextCrawlerState(
      { status: 'healthy', consecutiveEmptyRuns: 0 },
      observation(null),
      NOW_ISO,
      NOW_MS,
    ).state;

    expect(quiet.advisory).toBe(false);
    expect(uninstrumented.advisory).toBe(false);
  });
});
