import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_MISSING_GRACE_MS,
  classifyCrawlerGenerationObserverReport,
  createCrawlerGenerationObserverReport,
  createSentinelSetBinding,
  validateCrawlerGenerationObserverReport,
} from '../scripts/lib/crawler-generation-observer-report.mjs';

const sentinelDigest = `sha256:${'1'.repeat(64)}`;
const siteCodeCommit = 'a'.repeat(40);
const corpusCodeCommit = 'b'.repeat(40);
const evaluatedAt = '2026-08-31T08:00:00.000Z';
const dispatchDiagnostics = Object.fromEntries(Array.from({ length: 23 }, (_, index) => [
  String(index + 1).padStart(2, '0'),
  { status: 'direct', runId: String(10_000 + index) },
]));

function report(status = 'ready', reasons: string[] = []) {
  const sentinelSet = createSentinelSetBinding([
    { digest: sentinelDigest },
    { digest: sentinelDigest },
  ]);
  return createCrawlerGenerationObserverReport({
    evaluatedAt,
    generationToken: '9001-2',
    siteCodeCommit,
    corpusCodeCommit,
    sentinelDigest,
    ...sentinelSet,
    dispatchDiagnostics,
    evidenceDigest: `sha256:${'2'.repeat(64)}`,
    status,
    reasons,
    barrier: status === 'ready' ? {
      translation: { mode: 'shadow', wouldDispatch: true, dispatched: false },
    } : null,
  });
}

function expectedBinding(value = report()) {
  return {
    generationToken: value.generationToken,
    siteCodeCommit: value.siteCodeCommit,
    corpusCodeCommit: value.corpusCodeCommit,
    sentinelDigest: value.sentinelDigest,
    sentinelSetDigest: value.sentinelSetDigest,
    sentinelReplayCount: value.sentinelReplayCount,
  };
}

describe('crawler generation observer report contract', () => {
  it('digests the ordered replay multiset including duplicate sentinel digests', () => {
    const first = createSentinelSetBinding([
      { digest: `sha256:${'2'.repeat(64)}` },
      { digest: sentinelDigest },
      { digest: sentinelDigest },
    ]);
    const reordered = createSentinelSetBinding([
      { digest: sentinelDigest },
      { digest: `sha256:${'2'.repeat(64)}` },
      { digest: sentinelDigest },
    ]);
    expect(first).toEqual(reordered);
    expect(first.sentinelReplayCount).toBe(3);
    expect(first.sentinelSetDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(createSentinelSetBinding([{ digest: sentinelDigest }]).sentinelSetDigest)
      .not.toBe(first.sentinelSetDigest);
  });

  it('validates the closed schema, self-digest and exact generation binding', () => {
    const value = report();
    expect(validateCrawlerGenerationObserverReport(value, expectedBinding(value)))
      .toEqual({ valid: true, errors: [] });
    expect(validateCrawlerGenerationObserverReport(
      { ...value, observer: { ...value.observer, status: 'waiting' } },
      expectedBinding(value),
    ).valid).toBe(false);
    expect(validateCrawlerGenerationObserverReport(value, {
      ...expectedBinding(value),
      sentinelReplayCount: 3,
    }).errors).toContain('sentinel_set_mismatch');
    const dispatching = {
      ...value,
      translation: { mode: 'shadow', wouldDispatch: true, dispatched: true },
    };
    expect(validateCrawlerGenerationObserverReport(dispatching, expectedBinding(value)).valid)
      .toBe(false);
    const unknownReason = createCrawlerGenerationObserverReport({
      ...value,
      status: 'blocked',
      reasons: ['future_unreviewed_reason'],
      barrier: null,
    });
    expect(validateCrawlerGenerationObserverReport(unknownReason).valid).toBe(false);
  });

  it('keeps waiting, infrastructure, malformed and stale evidence retryable', () => {
    for (const value of [
      report('waiting', ['caller_runs_incomplete']),
      report('infrastructure_error', ['github_api_failed']),
    ]) {
      expect(classifyCrawlerGenerationObserverReport(value, {
        expected: expectedBinding(value),
        now: Date.parse(evaluatedAt) + 1_000,
        sentinelCreatedAt: Date.parse(evaluatedAt),
      }).terminal).toBe(false);
    }
    const ready = report();
    expect(classifyCrawlerGenerationObserverReport(
      { ...ready, digest: `sha256:${'f'.repeat(64)}` },
      {
        expected: expectedBinding(ready),
        now: Date.parse(evaluatedAt) + 1_000,
        sentinelCreatedAt: Date.parse(evaluatedAt),
      },
    )).toMatchObject({ terminal: false, reason: 'report_malformed' });
    expect(classifyCrawlerGenerationObserverReport(ready, {
      expected: { ...expectedBinding(ready), sentinelReplayCount: 3 },
      now: Date.parse(evaluatedAt) + 1_000,
      sentinelCreatedAt: Date.parse(evaluatedAt),
    })).toMatchObject({ terminal: false, reason: 'report_stale' });
  });

  it('terminalizes ready and definitive blocked evidence, with artifact-missing grace', () => {
    const ready = report();
    expect(classifyCrawlerGenerationObserverReport(ready, {
      expected: expectedBinding(ready),
      now: Date.parse(evaluatedAt) + 1_000,
      sentinelCreatedAt: Date.parse(evaluatedAt),
    })).toMatchObject({ terminal: true, reason: 'ready' });

    const missing = report('blocked', ['artifact_missing']);
    expect(classifyCrawlerGenerationObserverReport(missing, {
      expected: expectedBinding(missing),
      now: Date.parse(evaluatedAt) + ARTIFACT_MISSING_GRACE_MS - 1,
      sentinelCreatedAt: Date.parse(evaluatedAt),
    }).terminal).toBe(false);
    expect(classifyCrawlerGenerationObserverReport(missing, {
      expected: expectedBinding(missing),
      now: Date.parse(evaluatedAt) + ARTIFACT_MISSING_GRACE_MS,
      sentinelCreatedAt: Date.parse(evaluatedAt),
    })).toMatchObject({ terminal: true, reason: 'artifact_missing' });
  });
});
