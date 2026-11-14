// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ASSEMBLE_OUTPUT_CACHE_VERSION,
  assembleCacheFileContract,
} from '../../scripts/assemble-jobs-dataset.mjs';
import { prepare, restore } from '../../scripts/ci/assemble-test-snapshot.mjs';

const roots: string[] = [];
const files = assembleCacheFileContract({ withStats: true, withSummaries: true, withExpired: true }).requiredSnapshotFiles;
const nodeMajor = process.versions.node.split('.')[0];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assemble-test-snapshot-'));
  roots.push(root);
  return root;
}

function writeSnapshot(
  snapshotRoot: string,
  sourceInputFingerprint: string,
  now: number,
  sourceCacheKey = `${sourceInputFingerprint}_stats`,
  sourceAgeMs = 5 * 60 * 1000,
) {
  fs.mkdirSync(snapshotRoot, { recursive: true });
  for (const name of files) fs.writeFileSync(path.join(snapshotRoot, name), `cached:${name}`);
  fs.writeFileSync(path.join(snapshotRoot, 'test-snapshot.json'), JSON.stringify({
    schemaVersion: 1,
    sourceRunId: '101',
    sourceRunAttempt: '1',
    sourceCapturedAt: new Date(now - sourceAgeMs).toISOString(),
    compatibilityFingerprint: 'compatible-code',
    outputCacheVersion: ASSEMBLE_OUTPUT_CACHE_VERSION,
    nodeMajor,
    mode: 'stats,summaries,expired',
    sourceInputFingerprint,
    sourceCacheKey,
    snapshotFiles: files,
    fileCount: files.length,
  }));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('hourly assemble test snapshot', () => {
  it('prepares from the pre-assemble cache key rather than rehashing post-assemble inputs', () => {
    const root = tempRoot();
    const snapshotRoot = path.join(root, '.cache', 'assemble-jobs-test-snapshot');
    const cacheKey = `${'a'.repeat(64)}_stats`;
    const inputFingerprint = cacheKey.slice(0, 64);
    const sourceDir = path.join(root, '.cache', 'assemble-jobs', cacheKey);
    const now = Date.now();
    fs.mkdirSync(sourceDir, { recursive: true });
    for (const name of files) fs.writeFileSync(path.join(sourceDir, name), `assembled:${name}`);
    fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify({
      inputFingerprint,
      cacheKey,
      outputCacheVersion: ASSEMBLE_OUTPUT_CACHE_VERSION,
      nodeMajor,
      includeTranslationHeld: false,
      withStats: true,
      withSummaries: true,
      withExpired: true,
      snapshotFiles: files,
      fileCount: files.length,
    }));

    prepare({
      root,
      snapshotRoot,
      sourceCacheKey: cacheKey,
      sourceRunId: '101',
      sourceRunAttempt: '1',
      sourceCapturedAt: new Date(now - 1000).toISOString(),
      compatibilityFingerprint: 'compatible-code',
      now,
    });

    const snapshotManifest = JSON.parse(fs.readFileSync(path.join(snapshotRoot, 'test-snapshot.json'), 'utf8'));
    expect(snapshotManifest.sourceCacheKey).toBe(cacheKey);
    expect(snapshotManifest.sourceInputFingerprint).toBe(inputFingerprint);
    expect(fs.readFileSync(path.join(snapshotRoot, files[0]), 'utf8')).toBe(`assembled:${files[0]}`);
  });

  it('reuses a fresh snapshot even when its source data is older than current inputs', () => {
    const root = tempRoot();
    const checkoutRoot = path.join(root, 'checkout');
    const snapshotRoot = path.join(root, 'snapshot');
    const now = Date.now();
    const outputs: Record<string, string> = {};
    writeSnapshot(snapshotRoot, 'a'.repeat(64), now);

    restore({
      root: checkoutRoot,
      snapshotRoot,
      expectedRunId: '101',
      expectedRunAttempt: '1',
      compatibilityFingerprint: 'compatible-code',
      now,
      output: (name, value) => { outputs[name] = value; },
    });

    expect(outputs.restored).toBe('true');
    expect(fs.readFileSync(path.join(checkoutRoot, 'data', files[0]), 'utf8')).toBe(`cached:${files[0]}`);
  });

  it('rejects a snapshot when its source key and input fingerprint disagree', () => {
    const root = tempRoot();
    const checkoutRoot = path.join(root, 'checkout');
    const snapshotRoot = path.join(root, 'snapshot');
    const now = Date.now();
    const outputs: Record<string, string> = {};
    writeSnapshot(snapshotRoot, 'a'.repeat(64), now, `${'b'.repeat(64)}_stats`);

    restore({
      root: checkoutRoot,
      snapshotRoot,
      expectedRunId: '101',
      expectedRunAttempt: '1',
      compatibilityFingerprint: 'compatible-code',
      now,
      output: (name, value) => { outputs[name] = value; },
    });

    expect(outputs.restored).toBe('false');
    expect(outputs.reason).toBe('snapshot source cache key does not match its input fingerprint');
    for (const name of files) {
      expect(fs.existsSync(path.join(checkoutRoot, 'data', name))).toBe(false);
      if (['jobs.json', 'expired-jobs.json', 'jobs-stats.json'].includes(name)) {
        expect(fs.existsSync(path.join(checkoutRoot, 'public', 'data', name))).toBe(false);
      }
    }
  });

  it('rejects a valid source snapshot after its one-hour freshness window', () => {
    const root = tempRoot();
    const checkoutRoot = path.join(root, 'checkout');
    const snapshotRoot = path.join(root, 'snapshot');
    const now = Date.now();
    const outputs: Record<string, string> = {};
    writeSnapshot(snapshotRoot, 'a'.repeat(64), now, undefined, 61 * 60 * 1000);

    restore({
      root: checkoutRoot,
      snapshotRoot,
      expectedRunId: '101',
      expectedRunAttempt: '1',
      compatibilityFingerprint: 'compatible-code',
      now,
      output: (name, value) => { outputs[name] = value; },
    });

    expect(outputs.restored).toBe('false');
    expect(outputs.reason).toBe('snapshot is older than 60 minutes or has an invalid timestamp');
    for (const name of files) expect(fs.existsSync(path.join(checkoutRoot, 'data', name))).toBe(false);
  });
});
