// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  ASSEMBLE_OUTPUT_CACHE_VERSION,
  assembleCacheFileContract,
} from '../../scripts/assemble-jobs-dataset.mjs';
import {
  buildSnapshotCacheKey,
  prepare,
  restore,
  snapshotCacheKeyFromMetadata,
} from '../../scripts/ci/assemble-test-snapshot.mjs';

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
  const manifest = {
    schemaVersion: 2,
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
  };
  fs.writeFileSync(path.join(snapshotRoot, 'test-snapshot.json'), JSON.stringify(manifest));
  return manifest;
}

function writeSelectedManifest(file: string, manifest: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest));
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
    const metadataPath = path.join(root, 'selected', 'test-snapshot.json');
    const now = Date.now();
    const outputs: Record<string, string> = {};
    writeSnapshot(snapshotRoot, 'a'.repeat(64), now);
    writeSelectedManifest(metadataPath, {
      ...JSON.parse(fs.readFileSync(path.join(snapshotRoot, 'test-snapshot.json'), 'utf8')),
      sourceRunId: '202',
      sourceRunAttempt: '2',
      sourceCapturedAt: new Date(now - 5 * 60 * 1000).toISOString(),
    });

    restore({
      root: checkoutRoot,
      snapshotRoot,
      metadataPath,
      expectedRunId: '202',
      expectedRunAttempt: '2',
      compatibilityFingerprint: 'compatible-code',
      now,
      output: (name, value) => { outputs[name] = value; },
    });

    expect(outputs.restored).toBe('true');
    expect(outputs.reason).toBe('snapshot from run 202, age 5 min');
    expect(fs.readFileSync(path.join(checkoutRoot, 'data', files[0]), 'utf8')).toBe(`cached:${files[0]}`);
  });

  it('rejects a cached snapshot for a different source key', () => {
    const root = tempRoot();
    const checkoutRoot = path.join(root, 'checkout');
    const snapshotRoot = path.join(root, 'snapshot');
    const metadataPath = path.join(root, 'selected', 'test-snapshot.json');
    const now = Date.now();
    const outputs: Record<string, string> = {};
    writeSnapshot(snapshotRoot, 'b'.repeat(64), now, `${'b'.repeat(64)}_stats`);
    writeSelectedManifest(metadataPath, {
      ...JSON.parse(fs.readFileSync(path.join(snapshotRoot, 'test-snapshot.json'), 'utf8')),
      sourceCacheKey: `${'a'.repeat(64)}_stats`,
      sourceInputFingerprint: 'a'.repeat(64),
    });

    restore({
      root: checkoutRoot,
      snapshotRoot,
      metadataPath,
      expectedRunId: '101',
      expectedRunAttempt: '1',
      compatibilityFingerprint: 'compatible-code',
      now,
      output: (name, value) => { outputs[name] = value; },
    });

    expect(outputs.restored).toBe('false');
    expect(outputs.reason).toBe('cached snapshot does not match the selected source cache key');
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
    const metadataPath = path.join(root, 'selected', 'test-snapshot.json');
    const now = Date.now();
    const outputs: Record<string, string> = {};
    writeSnapshot(snapshotRoot, 'a'.repeat(64), now, undefined, 61 * 60 * 1000);
    writeSelectedManifest(metadataPath, JSON.parse(fs.readFileSync(path.join(snapshotRoot, 'test-snapshot.json'), 'utf8')));

    restore({
      root: checkoutRoot,
      snapshotRoot,
      metadataPath,
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

  it('uses a stable cache key for the same compatible source dataset across workflow runs', () => {
    const compatibilityFingerprint = 'c'.repeat(64);
    const sourceCacheKey = `${'a'.repeat(64)}_stats`;

    const first = buildSnapshotCacheKey({ runnerOs: 'Linux', compatibilityFingerprint, sourceCacheKey });
    const second = buildSnapshotCacheKey({ runnerOs: 'Linux', compatibilityFingerprint, sourceCacheKey });

    expect(first).toBe(second);
    expect(first).toBe(`assemble-jobs-test-snapshot-Linux-${compatibilityFingerprint}-${sourceCacheKey}`);
    expect(buildSnapshotCacheKey({
      runnerOs: 'Linux',
      compatibilityFingerprint,
      sourceCacheKey: `${'b'.repeat(64)}_stats`,
    })).not.toBe(first);
  });

  it('selects the stable key from a fresh manifest belonging to the latest workflow run', () => {
    const root = tempRoot();
    const metadataPath = path.join(root, 'test-snapshot.json');
    const now = Date.now();
    const manifest = writeSnapshot(root, 'a'.repeat(64), now);
    manifest.sourceRunId = '202';
    manifest.sourceRunAttempt = '2';
    manifest.compatibilityFingerprint = 'c'.repeat(64);
    writeSelectedManifest(metadataPath, manifest);

    expect(snapshotCacheKeyFromMetadata({
      metadataPath,
      expectedRunId: '202',
      expectedRunAttempt: '2',
      compatibilityFingerprint: 'c'.repeat(64),
      runnerOs: 'Linux',
      now,
    })).toBe(`assemble-jobs-test-snapshot-Linux-${'c'.repeat(64)}-${'a'.repeat(64)}_stats`);

    expect(() => snapshotCacheKeyFromMetadata({
      metadataPath,
      expectedRunId: '203',
      expectedRunAttempt: '2',
      compatibilityFingerprint: 'c'.repeat(64),
      runnerOs: 'Linux',
      now,
    })).toThrow('snapshot run id does not match the selected workflow run');
  });

  it('wires scheduled snapshot publication and PR restore through the stable key', () => {
    const seed = YAML.parse(fs.readFileSync(
      new URL('../../.github/workflows/hourly-test-assemble-snapshot.yml', import.meta.url),
      'utf8',
    )) as any;
    const testsWorkflow = YAML.parse(fs.readFileSync(
      new URL('../../.github/workflows/tests.yml', import.meta.url),
      'utf8',
    )) as any;
    const seedSteps = seed.jobs.seed.steps as Array<Record<string, any>>;
    const testSteps = testsWorkflow.jobs.vitest.steps as Array<Record<string, any>>;
    const cacheKey = seedSteps.find((step) => step.id === 'snapshot_cache_key');
    const cacheSave = seedSteps.find((step) => step.name === 'Save hourly test snapshot');
    const manifestArtifact = seedSteps.find((step) => step.name === 'Publish latest snapshot manifest');
    const pruneSnapshots = seedSteps.find((step) => step.name === 'Prune older hourly test snapshots');
    const metadataDownload = testSteps.find((step) => step.id === 'latest_hourly_snapshot_manifest');
    const selectedKey = testSteps.find((step) => step.id === 'hourly_snapshot_key');
    const cacheRestore = testSteps.find((step) => step.id === 'hourly_snapshot_cache');

    expect((seed.on ?? seed['on']).schedule).toEqual([{ cron: '7,37 * * * *' }]);
    expect(cacheKey?.run).toContain('assemble-test-snapshot.mjs cache-key');
    expect(cacheSave?.with?.key).toBe('${{ steps.snapshot_cache_key.outputs.key }}');
    expect(manifestArtifact?.with?.name).toBe('assemble-test-snapshot-manifest');
    expect(pruneSnapshots?.with?.script).toContain('github.paginate');
    expect(pruneSnapshots?.with?.script).toContain('github.rest.actions.deleteActionsCacheById');
    expect(metadataDownload?.uses).toBe('actions/download-artifact@v8');
    expect(selectedKey?.run).toContain('assemble-test-snapshot.mjs cache-key');
    expect(cacheRestore?.with?.key).toBe('${{ steps.hourly_snapshot_key.outputs.key }}');
  });
});
