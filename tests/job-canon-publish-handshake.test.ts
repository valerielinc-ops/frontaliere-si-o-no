import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import {
  compareMapTrees,
  parseRcloneChangedKeys,
} from '../scripts/ci/job-canon-affected-files.mjs';
import { verifyMapFreshness } from '../scripts/ci/job-canon-publish-handshake.mjs';
import { verifyMarker } from '../scripts/ci/cdn-build-marker-handshake.mjs';

const PREP_SH = readFileSync(resolve('scripts/lib/deploy-it-pages-prep.sh'), 'utf8');
const WAIT_SH = readFileSync(resolve('scripts/lib/wait-cdn-build-id.sh'), 'utf8');
const PUBLISH_YML = readFileSync(resolve('.github/workflows/deploy-publish.yml'), 'utf8');
const PUBLISH = YAML.parse(PUBLISH_YML) as {
  jobs: Record<string, { outputs?: Record<string, unknown>; steps?: Array<Record<string, any>> }>;
};

function workflowStep(jobName: string, id: string) {
  const step = PUBLISH.jobs[jobName]?.steps?.find((candidate) => candidate.id === id);
  if (!step) throw new Error(`missing workflow step ${jobName}.${id}`);
  return step;
}

function runWorkflowBash(run: unknown, runnerTemp: string, extraEnv: Record<string, string>) {
  return spawnSync('bash', ['-c', String(run)], {
    encoding: 'utf8',
    env: { ...process.env, RUNNER_TEMP: runnerTemp, ...extraEnv },
  });
}

function fixtureTree() {
  const root = mkdtempSync(join(tmpdir(), 'job-canon-handshake-'));
  const current = join(root, 'current');
  const previous = join(root, 'previous');
  mkdirSync(join(current, 'v2'), { recursive: true });
  mkdirSync(join(previous, 'v2'), { recursive: true });
  return { root, current, previous };
}

describe('job-canon publication handshake', () => {
  it('exports only the matching early job-canon receipt without changing cdn-ready status', () => {
    const cdnReady = workflowStep('publish-it-cdn', 'cdn-ready');
    const run = String(cdnReady.run);
    const root = mkdtempSync(join(tmpdir(), 'job-canon-cdn-ready-'));
    const receipt = join(root, 'job-canon-publish.ok');
    const output = join(root, 'github-output');
    try {
      expect(run).not.toContain('${{');
      expect(cdnReady.if).toBe('always()');
      expect(cdnReady.env.EXPECTED_BUILD_ID).toBe('${{ needs.resolve-publish-plan.outputs.build_id }}');
      expect(PUBLISH.jobs['publish-it-cdn'].outputs?.job_canon_build_id)
        .toBe('${{ steps.cdn-ready.outputs.job_canon_build_id }}');
      expect(PUBLISH.jobs['publish-it-cdn'].outputs?.cdn_build_id)
        .toBe('${{ steps.cdn-ready.outputs.build_id }}');
      expect(PUBLISH.jobs['publish-it-cdn'].outputs?.cdn_base)
        .toBe('${{ steps.cdn-ready.outputs.cdn_base }}');

      const cases = [
        { receiptContent: ' build-42 \n', expectedOutput: 'job_canon_build_id=build-42\n' },
        { receiptContent: 'build-43\n', expectedOutput: 'job_canon_build_id=\n' },
        { receiptContent: null, expectedOutput: 'job_canon_build_id=\n' },
      ];
      for (const testCase of cases) {
        if (testCase.receiptContent === null) rmSync(receipt, { force: true });
        else writeFileSync(receipt, testCase.receiptContent);
        writeFileSync(output, '');
        const result = runWorkflowBash(run, root, {
          EARLY_OUTCOME: 'success',
          RETRY_OUTCOME: 'skipped',
          EXPECTED_BUILD_ID: 'build-42',
          GITHUB_OUTPUT: output,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(readFileSync(output, 'utf8')).toContain(testCase.expectedOutput);
      }

      rmSync(receipt, { force: true });
      writeFileSync(output, '');
      const failedPush = runWorkflowBash(run, root, {
        EARLY_OUTCOME: 'failure',
        RETRY_OUTCOME: 'failure',
        EXPECTED_BUILD_ID: 'build-42',
        GITHUB_OUTPUT: output,
      });
      expect(failedPush.status).toBe(1);
      expect(readFileSync(output, 'utf8')).not.toContain('job_canon_build_id=');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs the finalizer gate with local or early receipt proof and fails closed otherwise', () => {
    const gate = workflowStep('finalize-it-publish', 'job-canon-publish-gate');
    const run = String(gate.run);
    const root = mkdtempSync(join(tmpdir(), 'job-canon-final-gate-'));
    const receipt = join(root, 'job-canon-publish.ok');
    try {
      expect(run).not.toContain('${{');
      expect(gate.if).toBe("steps.deploy-prep-it.outcome == 'success'");
      expect(gate.env.EARLY_JOB_CANON_BUILD_ID)
        .toBe('${{ needs.publish-it-cdn.outputs.job_canon_build_id }}');
      expect(gate.env.EARLY_JOB_CANON_BUILD_ID).not.toContain('resolve-publish-receipts');

      const cases = [
        {
          receiptContent: 'build-42\n',
          earlyBuildId: '',
          status: 0,
          output: 'job-canon handshake closed for build build-42\n',
        },
        {
          receiptContent: null,
          earlyBuildId: 'build-42',
          status: 0,
          output: 'job-canon handshake closed for build build-42 (by the early CDN job)\n',
        },
        {
          receiptContent: null,
          earlyBuildId: '',
          status: 1,
          output: 'job-canon publication receipt is missing; refusing to upload a Pages artifact with bridge removals',
        },
        {
          receiptContent: null,
          earlyBuildId: 'build-43',
          status: 1,
          output: 'job-canon publication receipt is missing; refusing to upload a Pages artifact with bridge removals',
        },
        {
          receiptContent: 'build-43\n',
          earlyBuildId: 'build-42',
          status: 1,
          output: 'job-canon publication receipt names build build-43, expected build-42',
        },
      ];
      for (const testCase of cases) {
        if (testCase.receiptContent === null) rmSync(receipt, { force: true });
        else writeFileSync(receipt, testCase.receiptContent);
        const result = runWorkflowBash(run, root, {
          EXPECTED_BUILD_ID: 'build-42',
          EARLY_JOB_CANON_BUILD_ID: testCase.earlyBuildId,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(testCase.status);
        expect(`${result.stdout}${result.stderr}`).toContain(testCase.output);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps deploy-publish if expressions wrapped as YAML expressions without mixed text', () => {
    const invalidIfs: string[] = [];
    const visit = (value: unknown, path: string) => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}[${index}]`));
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${key}` : key;
        if (key === 'if' && typeof child === 'string' && child.includes('${{')
          && !/^\s*\$\{\{[\s\S]*\}\}\s*$/.test(child)) {
          invalidIfs.push(childPath);
        }
        visit(child, childPath);
      }
    };

    visit(PUBLISH, '');
    expect(invalidIfs).toEqual([]);
  });

  it('inventories changed, added, and deleted Pages shards by bytes', () => {
    const { root, current, previous } = fixtureTree();
    try {
      writeFileSync(join(previous, '01.json'), '{"same":true}');
      writeFileSync(join(current, '01.json'), '{"same":true}');
      writeFileSync(join(previous, '02.json'), '{"old":true}');
      writeFileSync(join(current, '02.json'), '{"new":true}');
      writeFileSync(join(previous, 'v2', 'abc.json'), '{"removed":true}');
      writeFileSync(join(current, 'v2', 'def.json'), '{"added":true}');

      expect(compareMapTrees(current, previous)).toEqual([
        'job-canon/02.json',
        'job-canon/v2/abc.json',
        'job-canon/v2/def.json',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts rclone copies and deletions but rejects untrusted records', () => {
    const log = [
      JSON.stringify({ msg: 'Copied (new)', object: 'job-canon/01.json' }),
      JSON.stringify({ msg: 'Deleted', object: 'v2/abc.json' }),
      JSON.stringify({ msg: 'Unchanged skipping', object: 'job-canon/02.json' }),
      JSON.stringify({ msg: 'Updated modification time', object: 'job-canon/03.json' }),
    ].join('\n');
    expect(parseRcloneChangedKeys(log)).toEqual(['job-canon/01.json', 'job-canon/v2/abc.json']);
    expect(() => parseRcloneChangedKeys(`${log}\npartial json`)).toThrow(/invalid rclone JSON log record/);
    expect(() => parseRcloneChangedKeys(JSON.stringify({ msg: 'Copied (new)', object: 'assets/nope.js' })))
      .toThrow(/unrecognized job-canon object/);
    expect(() => parseRcloneChangedKeys(JSON.stringify({ msg: 'Unknown operation', object: 'job-canon/01.json' })))
      .toThrow(/unrecognized rclone object record/);
  });

  it('fails closed when the R2 log file is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'job-canon-inventory-'));
    try {
      const current = join(root, 'current');
      const output = join(root, 'affected.txt');
      mkdirSync(current, { recursive: true });
      writeFileSync(join(current, '00.json'), '{"changed":true}\n');
      expect(() => execFileSync(process.execPath, [
        resolve('scripts/ci/job-canon-affected-files.mjs'),
        `--current-dir=${current}`,
        `--rclone-log=${join(root, 'missing.jsonl')}`,
        `--output=${output}`,
      ], { encoding: 'utf8' })).toThrow(/rclone JSON log is missing/);
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires live bytes to match the staged shard and accepts a deleted shard only as 404/410', async () => {
    const { root, current } = fixtureTree();
    try {
      const bytes = Buffer.from('{"canonical":"/it/job/"}');
      writeFileSync(join(current, '01.json'), bytes);
      const fetchImpl = async (url: string) => ({
        status: url.endsWith('deleted.json') ? 404 : 200,
        headers: { get: () => '' },
        arrayBuffer: async () => bytes,
      });
      await verifyMapFreshness(
        ['job-canon/01.json', 'job-canon/v2/deleted.json'],
        current,
        'https://cdn.example.test',
        fetchImpl,
      );

      const staleFetch = async () => ({
        status: 200,
        headers: { get: () => '' },
        arrayBuffer: async () => Buffer.from('{"stale":true}'),
      });
      try {
        await verifyMapFreshness(['job-canon/01.json'], current, 'https://cdn.example.test', staleFetch);
        throw new Error('stale shard unexpectedly passed validation');
      } catch (error: any) {
        expect(error.message).toContain('job-canon live validation failed');
        expect(error.errors?.[0]?.message).toContain('live bytes are stale');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks both the stable and query-busted marker URL', async () => {
    const seen: string[] = [];
    await verifyMarker('43874484314', 'https://cdn.example.test', async (url: string) => {
      seen.push(url);
      return { status: 200, text: async () => '43874484314' };
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe('https://cdn.example.test/cdn-build-id.txt');
    expect(seen[1]).toMatch(/^https:\/\/cdn\.example\.test\/cdn-build-id\.txt\?nocache=handshake-/);
  });

  it('fails closed before releasing bridge-removed Pages artifacts', () => {
    expect(PREP_SH).toContain('job-canon-publish-handshake.mjs');
    expect(PREP_SH).toContain('cdn-build-marker-handshake.mjs');
    expect(PREP_SH).toContain('copy_mode=sync');
    expect(PREP_SH).toContain('rm -f "$stage/cdn-build-id.txt"');
    expect(WAIT_SH).toContain('poll_url="${url}?nocache=${attempt}-${elapsed}"');
    expect(PUBLISH_YML).toContain('Deploy prep (IT → Pages + CDN)');
    expect(PUBLISH_YML).toContain('Require closed job-canon handshake before Pages artifact');
    expect(PUBLISH_YML.indexOf('Require closed job-canon handshake before Pages artifact'))
      .toBeLessThan(PUBLISH_YML.indexOf('Upload Pages artifact (compression-level 9)'));
    expect(PUBLISH_YML).toContain('Upload Pages artifact (compression-level 9)');
  });
});
