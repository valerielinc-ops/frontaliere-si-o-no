// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
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

    expect((seed.on ?? seed['on']).schedule).toEqual([{ cron: '41 * * * *' }]);
    expect(seed.concurrency).toEqual({ group: 'hourly-test-assemble-snapshot', 'cancel-in-progress': false });
    expect(seedSteps[0].id).toBe('guard');
    expect(seedSteps[1].id).toBe('snapshot_source_time');
    expect(seedSteps[2].name).toBe('Checkout main');
    for (const step of seedSteps.slice(1)) {
      expect(String(step.if), step.name).toContain("steps.guard.outputs.proceed == 'true'");
    }
    expect(cacheKey?.run).toContain('assemble-test-snapshot.mjs cache-key');
    expect(cacheSave?.with?.key).toBe('${{ steps.snapshot_cache_key.outputs.key }}');
    expect(manifestArtifact?.with?.name).toBe('assemble-test-snapshot-manifest');
    expect(pruneSnapshots?.with?.script).toContain('github.paginate');
    expect(pruneSnapshots?.with?.script).toContain('github.rest.actions.deleteActionsCacheById');
    expect(metadataDownload?.uses).toBe('actions/download-artifact@v8');
    expect(selectedKey?.run).toContain('assemble-test-snapshot.mjs cache-key');
    expect(cacheRestore?.with?.key).toBe('${{ steps.hourly_snapshot_key.outputs.key }}');
  });

  it('skips malformed cache entries while pruning older snapshots', async () => {
    const seed = YAML.parse(fs.readFileSync(
      new URL('../../.github/workflows/hourly-test-assemble-snapshot.yml', import.meta.url),
      'utf8',
    )) as any;
    const pruneSnapshots = (seed.jobs.seed.steps as Array<Record<string, any>>)
      .find((step) => step.name === 'Prune older hourly test snapshots');
    const prefix = 'assemble-jobs-test-snapshot-Linux-';
    const currentKey = prefix + 'current';
    const deletedCacheIds: number[] = [];
    const warnings: string[] = [];

    await runInNewContext('(async () => {\n' + pruneSnapshots.with.script + '\n})()', {
      github: {
        paginate: async () => [
          undefined,
          { key: currentKey, id: 1, created_at: '2026-11-15T00:03:00.000Z' },
          { key: prefix + 'previous-1', id: 2, created_at: '2026-11-15T00:02:00.000Z' },
          { key: prefix + 'previous-2', id: 3, created_at: '2026-11-15T00:01:00.000Z' },
          { key: prefix + 'old', id: 4, created_at: '2026-11-15T00:00:00.000Z' },
        ],
        rest: {
          actions: {
            getActionsCacheList: () => undefined,
            deleteActionsCacheById: async ({ cache_id }: { cache_id: number }) => {
              deletedCacheIds.push(cache_id);
            },
          },
        },
      },
      core: {
        info: () => undefined,
        warning: (message: string) => warnings.push(message),
      },
      context: { repo: { owner: 'owner', repo: 'repo' } },
      process: { env: { CURRENT_SNAPSHOT_CACHE_KEY: currentKey } },
    });

    expect(deletedCacheIds).toEqual([4]);
    expect(warnings).toEqual(['Ignored 1 malformed cache entries while pruning']);
  });

  describe('one-seed-an-hour guard', () => {
    const seedWorkflow = YAML.parse(fs.readFileSync(
      new URL('../../.github/workflows/hourly-test-assemble-snapshot.yml', import.meta.url),
      'utf8',
    )) as any;
    const guardScript = (seedWorkflow.jobs.seed.steps as Array<Record<string, any>>)
      .find((step) => step.id === 'guard').with.script as string;
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

    async function runGuard(runs: any[], options: { withManifest?: Set<number>; listFails?: boolean } = {}) {
      const outputs: Record<string, string> = {};
      const logs: string[] = [];
      await runInNewContext('(async () => {\n' + guardScript + '\n})()', {
        github: {
          rest: {
            actions: {
              listWorkflowRuns: async () => {
                if (options.listFails) throw new Error('boom');
                return { data: { workflow_runs: runs } };
              },
              listWorkflowRunArtifacts: async ({ run_id }: { run_id: number }) => ({
                data: { total_count: options.withManifest?.has(run_id) ? 1 : 0 },
              }),
            },
          },
        },
        core: {
          setOutput: (name: string, value: string) => { outputs[name] = value; },
          info: (message: string) => logs.push(message),
          warning: (message: string) => logs.push(`warning: ${message}`),
        },
        context: { repo: { owner: 'owner', repo: 'repo' }, runId: 100 },
      });
      return { proceed: outputs.proceed, logs };
    }

    const self = { id: 100, status: 'in_progress', created_at: minutesAgo(1) };

    it('skips when an older seed run is still in flight', async () => {
      const result = await runGuard([self, { id: 99, status: 'in_progress', created_at: minutesAgo(5) }]);
      expect(result.proceed).toBe('false');
      expect(result.logs.join('\n')).toContain('99');
    });

    it('does not skip because of a newer queued run', async () => {
      const result = await runGuard([{ id: 101, status: 'queued', created_at: minutesAgo(0) }, self]);
      expect(result.proceed).toBe('true');
    });

    it('skips after a real successful seed in the last 50 minutes', async () => {
      const result = await runGuard(
        [self, { id: 90, status: 'completed', conclusion: 'success', created_at: minutesAgo(30) }],
        { withManifest: new Set([90]) },
      );
      expect(result.proceed).toBe('false');
    });

    it('seeds when the last real success is older than 50 minutes', async () => {
      const result = await runGuard(
        [self, { id: 90, status: 'completed', conclusion: 'success', created_at: minutesAgo(55) }],
        { withManifest: new Set([90]) },
      );
      expect(result.proceed).toBe('true');
    });

    it('is not blocked by a failed run or by a green run that was itself skipped', async () => {
      const result = await runGuard([
        self,
        { id: 95, status: 'completed', conclusion: 'failure', created_at: minutesAgo(10) },
        { id: 94, status: 'completed', conclusion: 'success', created_at: minutesAgo(20) },
      ]);
      expect(result.proceed).toBe('true');
    });

    it('fails open when the runs cannot be listed', async () => {
      const result = await runGuard([], { listFails: true });
      expect(result.proceed).toBe('true');
      expect(result.logs.join('\n')).toContain('Could not inspect earlier seed runs');
    });
  });

  it('records the cache-key error in GITHUB_OUTPUT before failing', () => {
    const root = tempRoot();
    const outputFile = path.join(root, 'github-output');
    fs.writeFileSync(outputFile, '');
    const result = spawnSync(process.execPath, ['scripts/ci/assemble-test-snapshot.mjs', 'cache-key'], {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputFile,
        ASSEMBLE_TEST_SNAPSHOT_METADATA_FILE: path.join(root, 'missing.json'),
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    const lines = fs.readFileSync(outputFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^error=\S/u);
    expect(lines[0]).not.toContain('\r');
  });

  describe('PR assemble snapshot outcome step', () => {
    const testsWorkflow = YAML.parse(fs.readFileSync(
      new URL('../../.github/workflows/tests.yml', import.meta.url),
      'utf8',
    )) as any;
    const steps = testsWorkflow.jobs.vitest.steps as Array<Record<string, any>>;
    const step = steps.find((candidate) => candidate.id === 'assemble_snapshot_outcome') as Record<string, any>;

    function run(env: Record<string, string>) {
      const root = tempRoot();
      const summary = path.join(root, 'summary');
      fs.writeFileSync(summary, '');
      const result = spawnSync('bash', ['-c', step.run], {
        env: { PATH: process.env.PATH ?? '', GITHUB_STEP_SUMMARY: summary, ...env },
        encoding: 'utf8',
      });
      const notice = result.stdout.split('\n').find((line) => line.startsWith('::notice title=assemble-snapshot-outcome::')) ?? '';
      return { status: result.status, notice, summary: fs.readFileSync(summary, 'utf8') };
    }

    const base = { ELIGIBILITY_OUTCOME: 'success', ELIGIBLE: 'true', SNAPSHOT_RUN_ID: '42' };

    it('runs after the assemble step, for PR and merge_group, and never when cancelled', () => {
      expect(steps.indexOf(step)).toBeGreaterThan(steps.findIndex((candidate) => candidate.id === 'assemble_jobs'));
      expect(step.if).toContain('!cancelled()');
      expect(step.if).toContain("steps.assemble.outputs.required == 'true'");
      expect(step.if).toContain("github.event_name == 'pull_request' || github.event_name == 'merge_group'");
      expect(step['continue-on-error']).toBe(true);
    });

    it.each([
      [{ SNAPSHOT_RESTORED: 'true' }, 'outcome=hit snapshot=hit '],
      [{ EXACT_CACHE_HIT: 'true' }, 'outcome=exact-cache-hit snapshot=cache-miss '],
      [{ ELIGIBLE: 'false', ELIGIBILITY_REASON: 'PR changes assembler input: x' }, 'outcome=ineligible snapshot=ineligible '],
      [{ SNAPSHOT_RUN_ID: '' }, 'outcome=absent snapshot=absent '],
      [{ SNAPSHOT_KEY_OUTCOME: 'failure', SNAPSHOT_KEY_ERROR: 'snapshot is older than 60 minutes or has an invalid timestamp' }, 'outcome=incompatible snapshot=stale '],
      [{ SNAPSHOT_KEY_OUTCOME: 'failure', SNAPSHOT_KEY_ERROR: 'snapshot output contract changed' }, 'outcome=incompatible snapshot=incompatible '],
      [{ SNAPSHOT_KEY_OUTCOME: 'success', SNAPSHOT_CACHE_HIT: 'false' }, 'outcome=incompatible snapshot=cache-miss '],
      [{ SNAPSHOT_KEY_OUTCOME: 'success', SNAPSHOT_CACHE_HIT: 'true', SNAPSHOT_RESTORE_REASON: 'hash mismatch' }, 'outcome=incompatible snapshot=restore-rejected '],
      [{ ELIGIBILITY_OUTCOME: 'skipped' }, 'outcome=cold snapshot=not-checked '],
    ])('classifies %j', (env, expectedPrefix) => {
      const full = { ...base, ...env };
      if ('EXACT_CACHE_HIT' in env) Object.assign(full, { SNAPSHOT_KEY_OUTCOME: 'success', SNAPSHOT_CACHE_HIT: 'false' });
      const { status, notice, summary } = run(full);
      expect(status).toBe(0);
      expect(notice).toContain(`::notice title=assemble-snapshot-outcome::${expectedPrefix}reason=`);
      expect(summary).toContain(notice.replace('::notice title=assemble-snapshot-outcome::', ''));
    });

    it('carries the restore reason when the restored snapshot is rejected', () => {
      const { notice } = run({
        ...base,
        SNAPSHOT_KEY_OUTCOME: 'success',
        SNAPSHOT_CACHE_HIT: 'true',
        SNAPSHOT_RESTORE_REASON: 'hash mismatch',
      });
      expect(notice).toContain('hash mismatch');
    });
  });
});
