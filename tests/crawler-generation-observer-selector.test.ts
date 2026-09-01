import { describe, expect, it } from 'vitest';
import {
  MAX_DISCOVERY_ARTIFACTS,
  MAX_DISCOVERY_BYTES,
  MAX_DISCOVERY_TOKENS,
  MAX_SCHEDULE_SELECTIONS,
  crawlerGenerationSentinelDiscoveryPath,
  recordDiscoveredArtifactIds,
  selectLatestCrawlerGenerationObserverReport,
  selectCrawlerGenerationReconciliations,
  validateObserverReportOwnerRun,
  validateSentinelOwnerRun,
} from '../scripts/crawler-generation-observer-selector.mjs';
import {
  createCrawlerGenerationObserverReport,
  createSentinelSetBinding,
} from '../scripts/lib/crawler-generation-observer-report.mjs';

const NOW = Date.parse('2026-08-31T20:23:00.000Z');
const siteCodeCommit = 'a'.repeat(40);
const corpusCodeCommit = 'b'.repeat(40);
const dispatchDiagnostics = Object.fromEntries(Array.from({ length: 23 }, (_, index) => [
  String(index + 1).padStart(2, '0'),
  { status: 'direct', runId: String(10_000 + index) },
]));

function candidate(token: string, options: Record<string, unknown> = {}) {
  const sentinelDigest = `sha256:${token.replace('-', '').padEnd(64, '0').slice(0, 64)}`;
  const sentinelSet = createSentinelSetBinding([{ digest: sentinelDigest }]);
  return {
    generationToken: token,
    sentinelRunId: String(90_000 + Number(token.split('-')[0])),
    siteCodeCommit,
    corpusCodeCommit,
    sentinelDigest,
    ...sentinelSet,
    sentinelCreatedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    dispatchMissing: false,
    allRunsTerminal: true,
    report: null,
    reportOwnerRun: null,
    ...options,
  };
}

function terminalReport(
  value: ReturnType<typeof candidate>,
  status = 'ready',
  reasons: string[] = [],
  evaluatedAt = new Date(NOW - 30 * 60 * 1000).toISOString(),
) {
  return createCrawlerGenerationObserverReport({
    evaluatedAt,
    generationToken: value.generationToken,
    siteCodeCommit: value.siteCodeCommit,
    corpusCodeCommit: value.corpusCodeCommit,
    sentinelDigest: value.sentinelDigest,
    sentinelSetDigest: value.sentinelSetDigest,
    sentinelReplayCount: value.sentinelReplayCount,
    dispatchDiagnostics,
    evidenceDigest: `sha256:${'e'.repeat(64)}`,
    status,
    reasons,
    barrier: status === 'ready'
      ? { translation: { mode: 'shadow', wouldDispatch: true, dispatched: false } }
      : null,
  });
}

function reportOwner(runId = 95_001, event = 'schedule') {
  const runName = event === 'schedule'
    ? `crawler-generation-observer-schedule-${runId}`
    : `crawler-generation-observer-event-${runId}`;
  return {
    id: runId,
    repository: { full_name: 'nanakokyobashi-rgb/frontaliere-articles' },
    path: '.github/workflows/crawler-generation-observer-shadow.yml',
    name: 'Crawler Generation Observer (shadow)',
    display_title: runName,
    event,
    head_branch: event === 'workflow_dispatch' ? 'crawler-generation-shadow-9001-2' : 'main',
    head_sha: corpusCodeCommit,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
  };
}

describe('crawler generation scheduled selector', () => {
  it('binds sentinel and report owners to exact static name, dynamic title and event-specific ref', () => {
    const sentinel = {
      ...reportOwner(90_001, 'workflow_dispatch'),
      name: 'Crawler Generation Observer (shadow)',
      display_title: 'crawler-generation-sentinel-9001-2',
    };
    expect(validateSentinelOwnerRun(sentinel, {
      runId: '90001', generationToken: '9001-2', corpusCodeCommit,
    })).toBe(true);
    expect(validateSentinelOwnerRun({ ...sentinel, path: '.github/workflows/spoof.yml' }, {
      runId: '90001', generationToken: '9001-2', corpusCodeCommit,
    })).toBe(false);
    expect(validateObserverReportOwnerRun(reportOwner(), '95001')).toBe(true);
    expect(validateObserverReportOwnerRun({ ...reportOwner(), display_title: 'spoof' }, '95001'))
      .toBe(false);
  });

  it('prioritizes no-report then least-recent retryable evidence and selects at most two', () => {
    const noReport = candidate('9001-2');
    const oldInfra = candidate('9002-1');
    oldInfra.report = terminalReport(oldInfra, 'infrastructure_error', ['github_api_failed']);
    oldInfra.reportOwnerRun = reportOwner(95_002);
    const newWaiting = candidate('9003-1');
    newWaiting.report = terminalReport(
      newWaiting,
      'waiting',
      ['caller_runs_incomplete'],
      new Date(NOW - 5 * 60 * 1000).toISOString(),
    );
    newWaiting.reportOwnerRun = reportOwner(95_003);
    const selected = selectCrawlerGenerationReconciliations({
      now: NOW,
      candidates: [newWaiting, oldInfra, noReport],
    });
    expect(selected).toEqual([
      expect.objectContaining({ generationToken: '9001-2', timedOut: false }),
      expect.objectContaining({ generationToken: '9002-1', timedOut: false }),
    ]);
    expect(selected).toHaveLength(MAX_SCHEDULE_SELECTIONS);
  });

  it('recovers a lost final event and retries transient heavy infrastructure on the next tick', () => {
    const eventLost = candidate('9010-1');
    const transient = candidate('9011-1');
    transient.report = terminalReport(transient, 'infrastructure_error', ['github_api_failed']);
    transient.reportOwnerRun = reportOwner(95_011);
    expect(selectCrawlerGenerationReconciliations({ now: NOW, candidates: [transient, eventLost] }))
      .toEqual([
        expect.objectContaining({ generationToken: '9010-1', timedOut: false }),
        expect.objectContaining({ generationToken: '9011-1', timedOut: false }),
      ]);
  });

  it('dedupes tokens, skips valid terminal evidence and retries stale/conflicting replays', () => {
    const done = candidate('9001-2');
    done.report = terminalReport(done);
    done.reportOwnerRun = reportOwner();
    expect(selectCrawlerGenerationReconciliations({ now: NOW, candidates: [done] })).toEqual([]);

    const replayed = candidate('9002-1', {
      sentinelReplayCount: 2,
      sentinelSetDigest: `sha256:${'f'.repeat(64)}`,
    });
    replayed.report = terminalReport(candidate('9002-1'));
    replayed.reportOwnerRun = reportOwner(95_002);
    const selected = selectCrawlerGenerationReconciliations({
      now: NOW,
      candidates: [replayed, structuredClone(replayed)],
    });
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ generationToken: '9002-1' });
  });

  it('waits for terminal groups before day 12, except dispatch-missing, then times out before expiry', () => {
    const incomplete = candidate('9001-2', { allRunsTerminal: false });
    expect(selectCrawlerGenerationReconciliations({ now: NOW, candidates: [incomplete] })).toEqual([]);
    expect(selectCrawlerGenerationReconciliations({
      now: NOW,
      candidates: [candidate('9002-1', { allRunsTerminal: false, dispatchMissing: true })],
    })[0]).toMatchObject({ generationToken: '9002-1', timedOut: false });
    const old = candidate('9003-1', {
      allRunsTerminal: false,
      sentinelCreatedAt: new Date(NOW - 12 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(selectCrawlerGenerationReconciliations({ now: NOW, candidates: [old] })[0])
      .toMatchObject({ generationToken: '9003-1', timedOut: true });
  });

  it('selects invalid exact group bindings immediately so the observer can persist definitive blocked evidence', () => {
    const invalid = candidate('9004-1', {
      allRunsTerminal: false,
      groupBindingInvalid: true,
    });
    expect(selectCrawlerGenerationReconciliations({ now: NOW, candidates: [invalid] })[0])
      .toMatchObject({ generationToken: '9004-1', timedOut: false });
  });

  it('validates every canonical report owner and chooses the newest valid report deterministically', () => {
    const value = candidate('9005-1');
    const older = terminalReport(value, 'infrastructure_error', ['github_api_failed']);
    const newer = terminalReport(value, 'ready', [], new Date(NOW - 5 * 60 * 1000).toISOString());
    const selected = selectLatestCrawlerGenerationObserverReport({
      generationToken: value.generationToken,
      records: [
        { artifactId: 3, ownerRun: { ...reportOwner(95_003), display_title: 'spoof' }, report: newer },
        { artifactId: 1, ownerRun: { ...reportOwner(95_001), created_at: '2026-08-31T18:00:00.000Z' }, report: older },
        { artifactId: 2, ownerRun: { ...reportOwner(95_002), created_at: '2026-08-31T19:00:00.000Z' }, report: newer },
      ],
    });
    expect(selected).toEqual({
      report: newer,
      reportOwnerRun: expect.objectContaining({ id: 95_002 }),
    });
  });

  it('exports closed caps for bounded discovery and output', () => {
    expect(MAX_DISCOVERY_TOKENS).toBe(32);
    expect(MAX_DISCOVERY_ARTIFACTS).toBe(100);
    expect(MAX_DISCOVERY_BYTES).toBe(1024 * 1024);
    expect(MAX_SCHEDULE_SELECTIONS).toBe(2);
    expect(crawlerGenerationSentinelDiscoveryPath(NOW)).toContain(
      'event=workflow_dispatch&created=%3E%3D2026-08-18T20%3A23%3A00.000Z&per_page=100',
    );
    expect(() => selectCrawlerGenerationReconciliations({
      now: NOW,
      candidates: Array.from({ length: MAX_DISCOVERY_TOKENS + 1 }, (_, index) => (
        candidate(`${10_000 + index}-1`)
      )),
    })).toThrow(/token cap/i);
  });

  it('counts artifact IDs once across per-run and name-filter discovery for a 13-day window', () => {
    const seen = new Set<number>();
    const artifacts = Array.from({ length: 26 }, (_, index) => ({ id: index + 1 }));
    expect(recordDiscoveredArtifactIds(seen, artifacts)).toBe(26);
    expect(recordDiscoveredArtifactIds(seen, structuredClone(artifacts))).toBe(26);
    expect(recordDiscoveredArtifactIds(seen, Array.from(
      { length: 26 },
      (_, index) => ({ id: 27 + index }),
    ))).toBe(52);
    const aged = Array.from({ length: 26 }, (_, index) => candidate(`${20_000 + index}-1`, {
      allRunsTerminal: false,
      sentinelCreatedAt: new Date(NOW - 12 * 24 * 60 * 60 * 1000).toISOString(),
    }));
    expect(selectCrawlerGenerationReconciliations({ now: NOW, candidates: aged })).toHaveLength(2);
  });
});
