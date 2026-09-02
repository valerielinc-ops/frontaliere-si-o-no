import { describe, expect, it } from 'vitest';
import {
  BARRIER_STATUSES,
  CRAWLER_GENERATION_DISPATCH_STATUSES,
  GROUP_IDS,
  GROUP_MANIFEST_REASON_CODES,
  createCrawlerGenerationRoster,
  createGroupTerminalManifest,
  digestDocument,
  evaluateCrawlerGenerationBarrier,
  validateCrawlerGenerationRoster,
  validateGroupTerminalManifest,
} from '../scripts/lib/crawler-generation-contract.mjs';

const checkedAt = '2026-08-31T08:00:00.000Z';
const remoteRepository = 'valerielinc-ops/frontaliere-si-o-no';
const callerRepository = 'nanakokyobashi-rgb/frontaliere-articles';
const hash = `sha256:${'1'.repeat(64)}`;
const blobOid = 'c'.repeat(40);

function crawlerId(group: string) { return `generation-${group}`; }
function slicePath(group: string) { return `data/jobs/by-crawler/generation-${group}.json`; }

function receipt(group = '01', outcome = 'pushed') {
  const payload = {
    schemaVersion: 1,
    crawlerId: crawlerId(group),
    outcome,
    commit: 'a'.repeat(40),
    remoteBaseCommit: 'b'.repeat(40),
    files: [{ path: slicePath(group), state: 'present', blobOid, sha256: hash }],
  };
  return { ...payload, digest: digestDocument(payload) };
}

function validManifest(group = '01', runId = '1001', generationToken: string | null = '9001-2') {
  return createGroupTerminalManifest({
    group,
    generationToken,
    callerRepository,
    callerRunId: runId,
    callerRunAttempt: 1,
    waitOutcome: 'success',
    checkedAt,
    remoteRepository,
    remoteRef: 'refs/heads/main',
    remoteCommit: 'a'.repeat(40),
    expectedCrawlerIds: [crawlerId(group)],
    expectedPrimarySlices: { [crawlerId(group)]: slicePath(group) },
    receipts: [receipt(group)],
    remoteSliceOids: { [slicePath(group)]: blobOid },
  });
}

function readyFixture() {
  const groups = Object.fromEntries(GROUP_IDS.map((group) => [group, [crawlerId(group)]]));
  const primarySlices = Object.fromEntries(GROUP_IDS.map((group) => [crawlerId(group), slicePath(group)]));
  const roster = createCrawlerGenerationRoster(groups, primarySlices);
  const runRegistry = {
    schemaVersion: 1, cycleId: '9001-2', generationToken: '9001-2',
    groups: Object.fromEntries(GROUP_IDS.map((group, index) => [group, {
      repository: callerRepository, workflow: `crawler-group-${group}.yml`, runId: String(10_000 + index),
      runName: `crawler-generation-9001-2-group-${group}`,
    }])),
  };
  const runObservations = Object.fromEntries(GROUP_IDS.map((group, index) => [group, {
    repository: callerRepository, runId: String(10_000 + index), runAttempt: 1,
    runName: `crawler-generation-9001-2-group-${group}`, status: 'completed', conclusion: 'success',
  }]));
  const manifests = Object.fromEntries(GROUP_IDS.map((group, index) => [group, validManifest(group, String(10_000 + index))]));
  return { roster, runRegistry, runObservations, manifests };
}

function evaluate(fixture: ReturnType<typeof readyFixture>, overrides = {}) {
  return evaluateCrawlerGenerationBarrier({
    cycleId: '9001-2', ...fixture, sourceCommit: 'f'.repeat(40), evaluatedAt: checkedAt,
    timedOut: false, isAncestor: () => true, sourceFileMatches: () => true, ...overrides,
  });
}

describe('crawler generation contracts', () => {
  it('keeps reason codes and barrier states closed', () => {
    expect(GROUP_MANIFEST_REASON_CODES).toEqual([
      'wait_failed', 'remote_fetch_failed', 'invalid_expected_roster', 'receipt_missing', 'receipt_invalid',
      'generation_token_missing',
      'receipt_primary_slice_missing', 'receipt_failed', 'receipt_commit_not_ancestor', 'receipt_blob_mismatch', 'slice_hash_mismatch',
      'duplicate_slice_ownership', 'manifest_internal_error',
    ]);
    expect(BARRIER_STATUSES).toEqual([
      'waiting', 'ready', 'blocked_dispatch_missing', 'blocked_group_failed', 'blocked_group_cancelled',
      'blocked_group_timed_out', 'blocked_manifest_missing', 'blocked_manifest_invalid', 'blocked_timeout',
    ]);
    expect(CRAWLER_GENERATION_DISPATCH_STATUSES).toEqual([
      'direct', 'reconciled_transport_error', 'reconciled_protocol_mismatch', 'rejected', 'missing',
      'duplicate', 'invalid_200_response', 'binding_mismatch', 'duplicate_run_id', 'api_protocol_mismatch',
    ]);
  });

  it('rejects duplicate primary-slice ownership across roster groups', () => {
    const groups = Object.fromEntries(GROUP_IDS.map((group) => [group, [crawlerId(group)]]));
    groups['01'].push('generation-extra');
    const primarySlices = Object.fromEntries(GROUP_IDS.map((group) => [crawlerId(group), slicePath(group)]));
    primarySlices['generation-extra'] = slicePath('01');
    expect(() => createCrawlerGenerationRoster(groups, primarySlices)).toThrow(/primary slices/i);
  });

  it('builds deterministic self-validating receipt-backed manifests', () => {
    const manifest = validManifest();
    expect(validManifest()).toEqual(manifest);
    expect(validateGroupTerminalManifest(manifest)).toEqual({ valid: true, errors: [] });
    expect(manifest).toMatchObject({ valid: true, expectedCrawlers: 1, verifiedCrawlers: 1, expectedSlices: 1, verifiedSlices: 1 });
    expect(manifest.receiptEvidence).toEqual([{
      crawlerId: 'generation-01', outcome: 'pushed', commit: 'a'.repeat(40), remoteBaseCommit: 'b'.repeat(40),
      receiptDigest: receipt().digest, fileCount: 1,
    }]);
    expect(manifest.receiptEvidence[0]).not.toHaveProperty('files');
    expect(manifest.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('allows token-null persistence evidence but never central readiness', () => {
    expect(validManifest('01', '1001', null).valid).toBe(true);
    const fixture = readyFixture();
    fixture.runRegistry.generationToken = null;
    fixture.manifests['01'] = validManifest('01', '10000', null);
    const report = evaluate(fixture);
    expect(report.barrier.status).toBe('blocked_dispatch_missing');
    expect(report.groups['01'].reasons).toContain('missing_or_invalid_generation_token');
  });

  it.each([
    ['failure', [receipt()], {}, 'wait_failed'],
    ['success', [], {}, 'receipt_missing'],
    ['success', [receipt('01', 'push_contention')], {}, 'receipt_failed'],
    ['success', [receipt()], { [slicePath('01')]: 'd'.repeat(40) }, 'slice_hash_mismatch'],
  ])('fails closed for wait/receipt/persistence condition %#', (waitOutcome, receipts, remoteSliceOids, reason) => {
    const manifest = createGroupTerminalManifest({
      group: '01', generationToken: '9001-2', callerRepository, callerRunId: '1001', callerRunAttempt: 1,
      waitOutcome, checkedAt, remoteRepository, remoteRef: 'refs/heads/main', remoteCommit: 'a'.repeat(40),
      expectedCrawlerIds: [crawlerId('01')], expectedPrimarySlices: { [crawlerId('01')]: slicePath('01') }, receipts, remoteSliceOids,
    });
    expect(manifest.valid).toBe(false);
    expect(manifest.reasons).toContain(reason);
    expect(validateGroupTerminalManifest(manifest).valid).toBe(true);
  });

  it('rejects forged schema, digest, reasons and duplicate crawler ownership', () => {
    const manifest = validManifest();
    expect(validateGroupTerminalManifest({ ...manifest, unexpected: true }).valid).toBe(false);
    expect(validateGroupTerminalManifest({ ...manifest, digest: `sha256:${'0'.repeat(64)}` }).valid).toBe(false);
    expect(validateGroupTerminalManifest({ ...manifest, reasons: ['future_reason'] }).valid).toBe(false);
    const forgedEvidence = { ...manifest.receiptEvidence[0], fileCount: 129 };
    const forgedPayload = { ...manifest, receiptEvidence: [forgedEvidence] };
    const { digest: _forgedDigest, ...forgedWithoutDigest } = forgedPayload;
    expect(validateGroupTerminalManifest({
      ...forgedWithoutDigest, digest: digestDocument(forgedWithoutDigest),
    }).errors).toContain('invalid_receipt_evidence_file_count');
    const duplicatePayload = { ...receipt('01'), crawlerId: 'other' };
    const { digest: _digest, ...payload } = duplicatePayload;
    const duplicate = { ...payload, digest: digestDocument(payload) };
    const ownedTwice = createGroupTerminalManifest({
      group: '01', generationToken: '9001-2', callerRepository, callerRunId: '1', callerRunAttempt: 1,
      waitOutcome: 'success', checkedAt, remoteRepository, remoteRef: 'refs/heads/main', remoteCommit: 'a'.repeat(40),
      expectedCrawlerIds: ['generation-01', 'other'],
      expectedPrimarySlices: { 'generation-01': slicePath('01'), other: slicePath('01') },
      receipts: [receipt(), duplicate], remoteSliceOids: { [slicePath('01')]: blobOid },
    });
    expect(ownedTwice.reasons).toContain('duplicate_slice_ownership');
  });

  it('rejects receipts missing the crawler-bound primary slice, including a wrong slice', () => {
    for (const files of [
      [{ path: 'data/jobs-ai-cache.json', state: 'present', blobOid, sha256: null }],
      [{ path: 'data/jobs/by-crawler/wrong.json', state: 'present', blobOid, sha256: hash }],
    ]) {
      const payload = {
        schemaVersion: 1, crawlerId: crawlerId('01'), outcome: 'pushed', commit: 'a'.repeat(40),
        remoteBaseCommit: 'b'.repeat(40), files,
      };
      const manifest = createGroupTerminalManifest({
        group: '01', generationToken: '9001-2', callerRepository, callerRunId: '1', callerRunAttempt: 1,
        waitOutcome: 'success', checkedAt, remoteRepository, remoteRef: 'refs/heads/main', remoteCommit: 'a'.repeat(40),
        expectedCrawlerIds: [crawlerId('01')], expectedPrimarySlices: { [crawlerId('01')]: slicePath('01') },
        receipts: [{ ...payload, digest: digestDocument(payload) }], remoteSliceOids: {},
      });
      expect(manifest.valid).toBe(false);
      expect(manifest.reasons).toContain('receipt_primary_slice_missing');
    }
  });

  it('accepts a roster-bound primary slice whose absence is explicitly attested at the immutable tip', () => {
    const payload = {
      schemaVersion: 1, crawlerId: crawlerId('01'), outcome: 'noop', commit: 'a'.repeat(40),
      remoteBaseCommit: 'a'.repeat(40),
      files: [{ path: slicePath('01'), state: 'absent', blobOid: null, sha256: null }],
    };
    const manifest = createGroupTerminalManifest({
      group: '01', generationToken: '9001-2', callerRepository, callerRunId: '1', callerRunAttempt: 1,
      waitOutcome: 'success', checkedAt, remoteRepository, remoteRef: 'refs/heads/main', remoteCommit: 'a'.repeat(40),
      expectedCrawlerIds: [crawlerId('01')], expectedPrimarySlices: { [crawlerId('01')]: slicePath('01') },
      receipts: [{ ...payload, digest: digestDocument(payload) }], remoteSliceOids: { [slicePath('01')]: null },
    });
    expect(manifest.valid).toBe(true);
    expect(manifest.slices[0]).toMatchObject({ state: 'absent', blobOid: null, remoteBlobOid: null, persisted: true });
  });

  it('requires exactly 23 globally unique crawler identities', () => {
    const groups = Object.fromEntries(GROUP_IDS.map((group) => [group, [crawlerId(group)]]));
    const primarySlices = Object.fromEntries(GROUP_IDS.map((group) => [crawlerId(group), slicePath(group)]));
    expect(validateCrawlerGenerationRoster(createCrawlerGenerationRoster(groups, primarySlices))).toEqual({ valid: true, errors: [] });
    expect(() => createCrawlerGenerationRoster({ ...groups, '01': [] }, primarySlices)).toThrow(/roster/i);
    expect(() => createCrawlerGenerationRoster({ ...groups, '02': [crawlerId('01')] }, primarySlices)).toThrow(/duplicate/i);
  });

  it('becomes ready only for 23 exact bindings, ancestry and immutable source hashes', () => {
    const report = evaluate(readyFixture());
    expect(report.barrier).toEqual({ status: 'ready', readyAt: checkedAt, sourceCommit: 'f'.repeat(40) });
    expect(report.translation).toEqual({ mode: 'shadow', wouldDispatch: true, dispatched: false });

    const mutated = evaluate(readyFixture(), { sourceFileMatches: () => false });
    expect(mutated.barrier.status).toBe('blocked_manifest_invalid');
    expect(mutated.groups['01'].reasons).toContain('source_slice_hash_mismatch');
  });

  it('accepts failure conclusion only when retry produced valid manifest and blocks exact lifecycle states', () => {
    const retried = readyFixture();
    retried.runObservations['01'] = { ...retried.runObservations['01'], conclusion: 'failure' };
    expect(evaluate(retried).barrier.status).toBe('ready');
    delete retried.manifests['01'];
    expect(evaluate(retried).barrier.status).toBe('blocked_group_failed');

    const cancelled = readyFixture();
    cancelled.runObservations['01'] = { ...cancelled.runObservations['01'], conclusion: 'cancelled' };
    expect(evaluate(cancelled).barrier.status).toBe('blocked_group_cancelled');
    const waiting = readyFixture();
    waiting.runObservations['01'] = { ...waiting.runObservations['01'], status: 'in_progress', conclusion: null };
    expect(evaluate(waiting).barrier.status).toBe('waiting');
    expect(evaluate(waiting, { timedOut: true }).barrier.status).toBe('blocked_timeout');
  });

  it('rejects duplicate run IDs, mismatched run names, ancestry and non-hash source refs', () => {
    const duplicate = readyFixture();
    duplicate.runRegistry.groups['02'].runId = duplicate.runRegistry.groups['01'].runId;
    expect(evaluate(duplicate).barrier.status).toBe('blocked_dispatch_missing');
    const wrongName = readyFixture();
    wrongName.runRegistry.groups['01'].runName = 'Crawler Group 01';
    expect(evaluate(wrongName).barrier.status).toBe('blocked_dispatch_missing');
    expect(evaluate(readyFixture(), { isAncestor: () => false }).barrier.status).toBe('blocked_manifest_invalid');
    expect(evaluate(readyFixture(), { sourceCommit: 'origin/main' }).barrier.sourceCommit).toBeNull();
    const oracleFailure = evaluate(readyFixture(), { sourceFileMatches: () => { throw new Error('git failure'); } });
    expect(oracleFailure.groups['01'].reasons).toContain('source_tree_check_failed');
  });
});
