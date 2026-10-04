// @vitest-environment node
/**
 * Crawler health: un membro che esce senza summary lascia lo stato congelato.
 *
 * A crawler-group member that exits non-zero publishes nothing: the group's
 * atomic commit only carries the descriptors of members whose crawl
 * succeeded, so even the exit guard's failure summary never reaches `main`.
 * The monitor then re-reads the previous summary, classifies it as a repeat
 * observation and leaves the state frozen (site issue 11069, `a-group`,
 * generations of 2026-10-03 21:11Z and 2026-10-04 09:11Z).
 *
 * The generation ledger is persisted even when the group fails: a member
 * absent from a generation in which its siblings did publish must count as an
 * aborted run named `summary-missing`, not as "nothing happened".
 */

import { describe, it, expect } from 'vitest';

import {
  applyGenerationSummaryAbsence,
  nextCrawlerState,
  parseCrawlerGenerationLedger,
  selectNewestCrawlerObservation,
  SUMMARY_MISSING_ABORT_KIND,
} from '../../scripts/check-crawler-health.mjs';

const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = Date.parse('2026-10-04T12:45:00.000Z');
const NOW_ISO = new Date(NOW_MS).toISOString();
const at = (hoursAgo: number) => new Date(NOW_MS - hoursAgo * HOUR_MS).toISOString();

// Three generations of one group, twelve hours apart.
const GEN_OLD = at(27);
const GEN_PREV = at(15);
const GEN_LATEST = at(3);

function ledgerLine(group: string, checkedAt: string, callerRunId: string) {
  return JSON.stringify({
    schemaVersion: 1,
    group,
    generationToken: '1-1',
    callerRepository: 'owner/corpus',
    callerRunId,
    callerRunAttempt: 1,
    checkedAt,
    remoteCommit: null,
    manifestDigest: `sha256:${'0'.repeat(64)}`,
    valid: false,
    reasons: ['wait_failed'],
    digest: `sha256:${'1'.repeat(64)}`,
  });
}

const LEDGER = [
  ledgerLine('11', GEN_OLD, '100'),
  ledgerLine('11', GEN_PREV, '200'),
  ledgerLine('11', GEN_LATEST, '300'),
  '',
].join('\n');

function summaryObs(slug: string, generatedAt: string | null, jobCount: number) {
  return {
    slug,
    freshnessAt: generatedAt,
    freshnessSource: 'summary',
    assembledAt: null,
    generatedAt,
    jobCount,
    activeJobCount: jobCount,
    discovered: null,
    written: null,
    parsed: null,
    detailDrop: null,
    authoritativeEmpty: false,
    lastFetchOutcome: null,
    abortKind: null,
    earlyExit: jobCount === 0,
    exitCode: jobCount === 0 ? 0 : null,
    codeCommit: null,
  };
}

// The failing member's last published summary is from BEFORE the previous
// generation; its siblings published inside the latest one.
const FROZEN_AT = at(27.5);
const observations = [
  summaryObs('a-group', FROZEN_AT, 0),
  summaryObs('luks', at(3.3), 12),
  summaryObs('pictet', at(3.2), 4),
];
const GROUPS = { '11': ['a-group', 'luks', 'pictet'] };

// The state the monitor wrote while observing that frozen summary.
const frozenPrev = {
  lastSuccessfulRunAt: at(150),
  lastNonZeroJobs: 1,
  consecutiveEmptyRuns: 3,
  consecutiveEmptyOkRuns: 4,
  advisory: false,
  advisoryReason: null,
  lastFailureReason: '3 consecutive runs aborted before publishing a result',
  status: 'broken',
  _lastObservedAt: at(24),
  _lastObservedJobs: 0,
  _lastObservedEmptyOk: false,
  _lastObservedFreshnessAt: FROZEN_AT,
  _lastObservedGeneratedAt: FROZEN_AT,
  _abortedRun: true,
};

function evaluate(prev: object | undefined, slug = 'a-group') {
  const { observations: next, absent } = applyGenerationSummaryAbsence(observations, {
    groups: GROUPS,
    ledgerEntries: parseCrawlerGenerationLedger(LEDGER),
  });
  const observation = next.find((o: { slug: string }) => o.slug === slug);
  return { observation, absent, ...nextCrawlerState(prev, observation, NOW_ISO, NOW_MS) };
}

describe('crawler health: a group member that exits without a summary', () => {
  it('records the generation as an aborted run instead of leaving the state frozen', () => {
    const { state, status, reason, absent } = evaluate(frozenPrev);

    expect(absent.map((a: { slug: string }) => a.slug)).toEqual(['a-group']);
    expect(state.consecutiveEmptyRuns).toBe(frozenPrev.consecutiveEmptyRuns + 1);
    expect(state._lastObservedFreshnessAt).toBe(GEN_LATEST);
    expect(state._lastObservedAbortKind).toBe(SUMMARY_MISSING_ABORT_KIND);
    expect(state._abortedRun).toBe(true);
    expect(status).toBe('broken');
    expect(reason).toContain(`abortKind=${SUMMARY_MISSING_ABORT_KIND}`);
    expect(reason).toContain('https://github.com/owner/corpus/actions/runs/300');
    expect(reason).toContain(FROZEN_AT);
  });

  it('does not advance twice for the same generation (repeat observation)', () => {
    const first = evaluate(frozenPrev);
    const second = evaluate(first.state);
    expect(second.state.consecutiveEmptyRuns).toBe(first.state.consecutiveEmptyRuns);
  });

  it('leaves siblings that published in the generation untouched', () => {
    const { observation, state } = evaluate(undefined, 'luks');
    expect(observation.summaryMissing).toBeUndefined();
    expect(observation.freshnessAt).toBe(at(3.3));
    expect(state._lastObservedAbortKind).toBeNull();
  });

  it('ignores a generation in which no member published (group-wide fault, reported once at group level)', () => {
    const { absent } = applyGenerationSummaryAbsence(
      observations.map((o) => ({ ...o, generatedAt: FROZEN_AT, freshnessAt: FROZEN_AT })),
      { groups: GROUPS, ledgerEntries: parseCrawlerGenerationLedger(LEDGER) },
    );
    expect(absent).toEqual([]);
  });

  it('needs a previous generation to bound the window', () => {
    const { absent } = applyGenerationSummaryAbsence(observations, {
      groups: GROUPS,
      ledgerEntries: parseCrawlerGenerationLedger(`${ledgerLine('11', GEN_LATEST, '300')}\n`),
    });
    expect(absent).toEqual([]);
  });

  it('treats a member that published after the previous generation as present', () => {
    const { absent } = applyGenerationSummaryAbsence(
      [summaryObs('a-group', at(10), 0), ...observations.slice(1)],
      { groups: GROUPS, ledgerEntries: parseCrawlerGenerationLedger(LEDGER) },
    );
    expect(absent).toEqual([]);
  });

  it('skips malformed ledger lines instead of failing the monitor', () => {
    const entries = parseCrawlerGenerationLedger(`not json\n{"group":"11"}\n${LEDGER}`);
    expect(entries.map((e: { callerRunId: string }) => e.callerRunId)).toEqual(['100', '200', '300']);
  });

  it('does not inherit diagnostics of an older corpus summary', () => {
    const { observation } = evaluate(frozenPrev);
    const olderCorpus = {
      ...summaryObs('a-group', FROZEN_AT, 0),
      freshnessSource: 'corpus-summary',
      lastFetchOutcome: 'selector_miss',
      abortKind: 'crash',
    };
    const winner = selectNewestCrawlerObservation(observation, olderCorpus, NOW_MS);
    expect(winner).toBe(observation);
    expect(winner.lastFetchOutcome).toBeNull();
  });
});
