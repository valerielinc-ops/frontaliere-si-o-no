import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { finalizeCrawlerGroup } from '../scripts/crawler-group-generation-finalizer.mjs';
import { digestDocument, validateGroupTerminalManifest } from '../scripts/lib/crawler-generation-contract.mjs';
import { MAX_RECEIPT_BYTES, createCrawlerGenerationReceipt } from '../scripts/lib/crawler-generation-receipt.mjs';

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixtureRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-generation-finalizer-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const receiptsDir = path.join(root, 'receipts');
  fs.mkdirSync(receiptsDir);
  execFileSync('git', ['init', '--bare', remote]);
  execFileSync('git', ['clone', remote, work]);
  git(work, ['config', 'user.name', 'Test']);
  git(work, ['config', 'user.email', 'test@example.invalid']);
  git(work, ['checkout', '-b', 'main']);
  const slice = 'data/jobs/by-crawler/acme.json';
  fs.mkdirSync(path.join(work, path.dirname(slice)), { recursive: true });
  fs.writeFileSync(path.join(work, slice), '{"jobs":[{"id":"one"}]}\n');
  git(work, ['add', slice]);
  git(work, ['commit', '-m', 'fixture']);
  git(work, ['push', '-u', 'origin', 'main']);
  return { root, remote, work, receiptsDir, slice, initial: git(work, ['rev-parse', 'HEAD']) };
}

function writeReceipt(fixture: ReturnType<typeof fixtureRepository>, receipt: object) {
  fs.writeFileSync(path.join(fixture.receiptsDir, 'acme.json'), `${JSON.stringify(receipt)}\n`);
}

function receiptFor(
  fixture: ReturnType<typeof fixtureRepository>,
  paths: string[],
  outcome = 'pushed',
  commit?: string,
  generationToken = '9001-2',
) {
  return createCrawlerGenerationReceipt({
    cwd: fixture.work, generationToken, crawlerId: 'acme', outcome,
    commit: commit ?? git(fixture.work, ['rev-parse', 'HEAD']), remoteBaseCommit: fixture.initial, paths,
  });
}

function baseInput(fixture: ReturnType<typeof fixtureRepository>) {
  return {
    cwd: fixture.work, group: '01', generationToken: '9001-2',
    callerRepository: 'nanakokyobashi-rgb/frontaliere-articles', callerRunId: '12345', callerRunAttempt: 2,
    waitOutcome: 'success', checkedAt: '2026-08-31T08:00:00.000Z',
    remoteRepository: 'valerielinc-ops/frontaliere-si-o-no', remoteName: 'origin', remoteRef: 'refs/heads/main',
    expectedCrawlers: [{ crawlerId: 'acme', primarySlice: fixture.slice }], receiptsDir: fixture.receiptsDir,
  };
}

describe('crawler group generation finalizer', () => {
  it('verifies the receipt commit and remote tip while ignoring a deliberately stale workspace', () => {
    const fixture = fixtureRepository();
    fs.writeFileSync(path.join(fixture.work, fixture.slice), '{"jobs":[{"id":"pushed"}]}\n');
    git(fixture.work, ['add', fixture.slice]);
    git(fixture.work, ['commit', '-m', 'crawler']);
    const pushedCommit = git(fixture.work, ['rev-parse', 'HEAD']);
    git(fixture.work, ['push', 'origin', 'main']);
    writeReceipt(fixture, receiptFor(fixture, [fixture.slice], 'pushed', pushedCommit));
    fs.writeFileSync(path.join(fixture.work, fixture.slice), '{"jobs":[{"id":"stale-worktree"}]}\n');
    const before = fs.readFileSync(path.join(fixture.work, fixture.slice));

    const manifest = finalizeCrawlerGroup(baseInput(fixture));

    expect(manifest.valid).toBe(true);
    expect(manifest.slices[0]).toMatchObject({ path: fixture.slice, crawlerId: 'acme', receiptCommit: pushedCommit, persisted: true });
    expect(validateGroupTerminalManifest(manifest)).toEqual({ valid: true, errors: [] });
    expect(fs.readFileSync(path.join(fixture.work, fixture.slice))).toEqual(before);
  });

  it('covers full multi-file receipts and records explicit absence without inventing a slice', () => {
    const fixture = fixtureRepository();
    const secondSlice = 'data/jobs/by-crawler/acme-extra.json';
    const absentSlice = 'data/jobs/by-crawler/acme-retired.json';
    fs.writeFileSync(path.join(fixture.work, secondSlice), '{"jobs":[]}\n');
    git(fixture.work, ['add', secondSlice]);
    git(fixture.work, ['commit', '-m', 'multi-slice']);
    git(fixture.work, ['push', 'origin', 'main']);
    writeReceipt(fixture, receiptFor(fixture, [fixture.slice, secondSlice, absentSlice]));

    const manifest = finalizeCrawlerGroup(baseInput(fixture));

    expect(manifest.valid).toBe(true);
    expect(manifest.slices.map((slice: { path: string }) => slice.path)).toEqual([fixture.slice, secondSlice, absentSlice].sort());
    expect(manifest.slices.find((slice: { path: string }) => slice.path === absentSlice)).toMatchObject({ state: 'absent', sha256: null, remoteSha256: null, persisted: true });
  });

  it.each([
    ['missing', (_fixture: ReturnType<typeof fixtureRepository>) => undefined, 'receipt_missing'],
    ['corrupt', (fixture: ReturnType<typeof fixtureRepository>) => fs.writeFileSync(path.join(fixture.receiptsDir, 'acme.json'), '{broken'), 'receipt_invalid'],
    ['oversized', (fixture: ReturnType<typeof fixtureRepository>) => fs.writeFileSync(
      path.join(fixture.receiptsDir, 'acme.json'),
      `{"padding":"${'x'.repeat(MAX_RECEIPT_BYTES)}"}`,
    ), 'receipt_invalid'],
    ['failed', (fixture: ReturnType<typeof fixtureRepository>) => {
      fs.writeFileSync(path.join(fixture.work, fixture.slice), '{"jobs":[{"id":"not-pushed"}]}\n');
      git(fixture.work, ['add', fixture.slice]);
      git(fixture.work, ['commit', '-m', 'failed push candidate']);
      writeReceipt(fixture, receiptFor(fixture, [fixture.slice], 'failed'));
    }, 'receipt_failed'],
  ])('fails closed for %s receipt', (_label, arrange, reason) => {
    const fixture = fixtureRepository();
    arrange(fixture);
    const manifest = finalizeCrawlerGroup(baseInput(fixture));
    expect(manifest.valid).toBe(false);
    expect(manifest.reasons).toContain(reason);
    expect(validateGroupTerminalManifest(manifest).valid).toBe(true);
  });

  it('detects a later remote mutation of a receipt-owned slice', () => {
    const fixture = fixtureRepository();
    writeReceipt(fixture, receiptFor(fixture, [fixture.slice], 'noop', fixture.initial));
    const other = path.join(fixture.root, 'other');
    execFileSync('git', ['clone', '--branch', 'main', fixture.remote, other]);
    git(other, ['config', 'user.name', 'Other']);
    git(other, ['config', 'user.email', 'other@example.invalid']);
    fs.writeFileSync(path.join(other, fixture.slice), '{"jobs":[{"id":"concurrent"}]}\n');
    git(other, ['add', fixture.slice]);
    git(other, ['commit', '-m', 'concurrent mutation']);
    git(other, ['push', 'origin', 'main']);

    const manifest = finalizeCrawlerGroup(baseInput(fixture));
    expect(manifest.valid).toBe(false);
    expect(manifest.reasons).toContain('slice_hash_mismatch');
  });

  it('rejects a forged receipt whose claimed base is not the commit parent', () => {
    const fixture = fixtureRepository();
    fs.writeFileSync(path.join(fixture.work, fixture.slice), '{"jobs":[{"id":"pushed"}]}\n');
    git(fixture.work, ['add', fixture.slice]);
    git(fixture.work, ['commit', '-m', 'crawler']);
    git(fixture.work, ['push', 'origin', 'main']);
    const real = receiptFor(fixture, [fixture.slice]);
    const { digest: _digest, ...payload } = { ...real, remoteBaseCommit: 'f'.repeat(40) };
    writeReceipt(fixture, { ...payload, digest: digestDocument(payload) });

    const manifest = finalizeCrawlerGroup(baseInput(fixture));

    expect(manifest.valid).toBe(false);
    expect(manifest.reasons).toContain('receipt_blob_mismatch');
  });

  it('rejects a valid receipt copied from a different generation directory', () => {
    const fixture = fixtureRepository();
    writeReceipt(fixture, receiptFor(fixture, [fixture.slice], 'noop', fixture.initial, '9001-1'));

    const manifest = finalizeCrawlerGroup(baseInput(fixture));

    expect(manifest.valid).toBe(false);
    expect(manifest.reasons).toEqual(expect.arrayContaining(['receipt_invalid', 'receipt_missing']));
    expect(manifest.verifiedCrawlers).toBe(0);
    expect(manifest.receiptEvidence).toEqual([]);
  });

  it('rejects a legacy receipt with no generation token in the token-bound finalizer', () => {
    const fixture = fixtureRepository();
    const current = receiptFor(fixture, [fixture.slice], 'noop', fixture.initial);
    const { digest: _digest, generationToken: _generationToken, ...legacyPayload } = current;
    const legacy = { ...legacyPayload, schemaVersion: 1 };
    writeReceipt(fixture, { ...legacy, digest: digestDocument(legacy) });

    const manifest = finalizeCrawlerGroup(baseInput(fixture));

    expect(manifest.valid).toBe(false);
    expect(manifest.reasons).toEqual(expect.arrayContaining(['receipt_invalid', 'receipt_missing']));
    expect(manifest.verifiedCrawlers).toBe(0);
  });

  it('tags a group dispatched without its own generation token distinctly from a bad receipt', () => {
    const fixture = fixtureRepository();
    writeReceipt(fixture, receiptFor(fixture, [fixture.slice], 'noop', fixture.initial));

    const manifest = finalizeCrawlerGroup({ ...baseInput(fixture), generationToken: null });

    expect(manifest.valid).toBe(false);
    expect(manifest.reasons).toContain('generation_token_missing');
    expect(manifest.reasons).not.toContain('receipt_invalid');
    expect(manifest.generationToken).toBeNull();
    expect(validateGroupTerminalManifest(manifest)).toEqual({ valid: true, errors: [] });
  });

  it('records wait and bounded non-interactive fetch failures without changing data', () => {
    const fixture = fixtureRepository();
    writeReceipt(fixture, receiptFor(fixture, [fixture.slice], 'noop', fixture.initial));
    const before = fs.readFileSync(path.join(fixture.work, fixture.slice));
    fs.renameSync(fixture.remote, `${fixture.remote}.offline`);
    const manifest = finalizeCrawlerGroup({ ...baseInput(fixture), waitOutcome: 'failure' });
    expect(manifest.reasons).toEqual(expect.arrayContaining(['wait_failed', 'remote_fetch_failed']));
    expect(fs.readFileSync(path.join(fixture.work, fixture.slice))).toEqual(before);
  });

  it.each(['failure', 'cancelled'])('preserves the terminal job status %s and fails closed', (waitOutcome) => {
    const fixture = fixtureRepository();
    writeReceipt(fixture, receiptFor(fixture, [fixture.slice], 'noop', fixture.initial));

    const manifest = finalizeCrawlerGroup({ ...baseInput(fixture), waitOutcome });

    expect(manifest.waitOutcome).toBe(waitOutcome);
    expect(manifest.valid).toBe(false);
    expect(manifest.reasons).toContain('wait_failed');
    expect(validateGroupTerminalManifest(manifest)).toEqual({ valid: true, errors: [] });
  });
});
