// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ASSEMBLE_OUTPUT_CACHE_VERSION,
  assembleCacheFileContract,
} from '../../scripts/assemble-jobs-dataset.mjs';
import { restore } from '../../scripts/ci/assemble-test-snapshot.mjs';

const roots: string[] = [];
const files = assembleCacheFileContract({ withStats: true, withSummaries: true, withExpired: true }).requiredSnapshotFiles;
const nodeMajor = process.versions.node.split('.')[0];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assemble-test-snapshot-'));
  roots.push(root);
  return root;
}

function writeSnapshot(snapshotRoot: string, sourceInputFingerprint: string, now: number) {
  fs.mkdirSync(snapshotRoot, { recursive: true });
  for (const name of files) fs.writeFileSync(path.join(snapshotRoot, name), `cached:${name}`);
  fs.writeFileSync(path.join(snapshotRoot, 'test-snapshot.json'), JSON.stringify({
    schemaVersion: 1,
    sourceRunId: '101',
    sourceRunAttempt: '1',
    sourceCapturedAt: new Date(now - 5 * 60 * 1000).toISOString(),
    compatibilityFingerprint: 'compatible-code',
    outputCacheVersion: ASSEMBLE_OUTPUT_CACHE_VERSION,
    nodeMajor,
    mode: 'stats,summaries,expired',
    sourceInputFingerprint,
    snapshotFiles: files,
    fileCount: files.length,
  }));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('hourly assemble test snapshot restore', () => {
  it('rejects and does not copy a snapshot when current assemble inputs changed', () => {
    const root = tempRoot();
    const checkoutRoot = path.join(root, 'checkout');
    const snapshotRoot = path.join(root, 'snapshot');
    const now = Date.now();
    const outputs: Record<string, string> = {};
    writeSnapshot(snapshotRoot, 'old-input-fingerprint', now);

    restore({
      root: checkoutRoot,
      snapshotRoot,
      expectedRunId: '101',
      expectedRunAttempt: '1',
      currentInputFingerprint: 'current-input-fingerprint',
      compatibilityFingerprint: 'compatible-code',
      now,
      output: (name, value) => { outputs[name] = value; },
    });

    expect(outputs.restored).toBe('false');
    expect(outputs.reason).toBe('assemble inputs changed since the snapshot was created');
    for (const name of files) {
      expect(fs.existsSync(path.join(checkoutRoot, 'data', name))).toBe(false);
      if (['jobs.json', 'expired-jobs.json', 'jobs-stats.json'].includes(name)) {
        expect(fs.existsSync(path.join(checkoutRoot, 'public', 'data', name))).toBe(false);
      }
    }
  });

  it('copies a fresh snapshot when its assemble input fingerprint matches', () => {
    const root = tempRoot();
    const checkoutRoot = path.join(root, 'checkout');
    const snapshotRoot = path.join(root, 'snapshot');
    const now = Date.now();
    const outputs: Record<string, string> = {};
    writeSnapshot(snapshotRoot, 'current-input-fingerprint', now);

    restore({
      root: checkoutRoot,
      snapshotRoot,
      expectedRunId: '101',
      expectedRunAttempt: '1',
      currentInputFingerprint: 'current-input-fingerprint',
      compatibilityFingerprint: 'compatible-code',
      now,
      output: (name, value) => { outputs[name] = value; },
    });

    expect(outputs.restored).toBe('true');
    expect(fs.readFileSync(path.join(checkoutRoot, 'data', files[0]), 'utf8')).toBe(`cached:${files[0]}`);
  });
});
