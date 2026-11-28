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
import { resolveJobCanonPublishProof } from '../scripts/ci/job-canon-publish-receipt.mjs';

const PREP_SH = readFileSync(resolve('scripts/lib/deploy-it-pages-prep.sh'), 'utf8');
const WAIT_SH = readFileSync(resolve('scripts/lib/wait-cdn-build-id.sh'), 'utf8');
const PUBLISH_YML = readFileSync(resolve('.github/workflows/deploy-publish.yml'), 'utf8');
const PUBLISH = YAML.parse(PUBLISH_YML) as {
  jobs: Record<string, { outputs?: Record<string, unknown>; steps?: Array<Record<string, any>> }>;
};
const SOURCE_RUN_ID = '43969699461';
const SOURCE_SHA = 'c'.repeat(40);
const BUILD_ID = '1770000000001';
const earlyProof = { sourceRunId: SOURCE_RUN_ID, sourceSha: SOURCE_SHA, buildId: BUILD_ID };
const durableReceipt = { published: 'true', ...earlyProof };

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

function runPublishHandshake(mapDir: string, affectedFile: string) {
  return spawnSync(process.execPath, [
    resolve('scripts/ci/job-canon-publish-handshake.mjs'),
    `--map-dir=${mapDir}`,
    `--affected-file=${affectedFile}`,
    '--base=https://cdn.example.test',
  ], { encoding: 'utf8', env: { CF_API_TOKEN: '' } });
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
  it('exports the verified early source and build identity from cdn-ready', () => {
    const cdnReady = workflowStep('publish-it-cdn', 'cdn-ready');
    const run = String(cdnReady.run);
    const root = mkdtempSync(join(tmpdir(), 'job-canon-cdn-ready-'));
    const receipt = join(root, 'job-canon-publish.ok');
    const output = join(root, 'github-output');
    try {
      expect(run).not.toContain('${{');
      expect(cdnReady.if).toBe('always()');
      expect(cdnReady.env.EXPECTED_BUILD_ID).toBe('${{ needs.resolve-publish-plan.outputs.build_id }}');
      expect(cdnReady.env.EXPECTED_SOURCE_RUN_ID).toBe('${{ inputs.source_run_id }}');
      expect(cdnReady.env.EXPECTED_SOURCE_SHA).toBe('${{ inputs.source_sha }}');
      expect(PUBLISH.jobs['publish-it-cdn'].outputs?.job_canon_source_run_id)
        .toBe('${{ steps.cdn-ready.outputs.job_canon_source_run_id }}');
      expect(PUBLISH.jobs['publish-it-cdn'].outputs?.job_canon_source_sha)
        .toBe('${{ steps.cdn-ready.outputs.job_canon_source_sha }}');
      expect(PUBLISH.jobs['publish-it-cdn'].outputs?.job_canon_build_id)
        .toBe('${{ steps.cdn-ready.outputs.job_canon_build_id }}');
      expect(PUBLISH.jobs['publish-it-cdn'].outputs?.cdn_build_id)
        .toBe('${{ steps.cdn-ready.outputs.build_id }}');
      expect(PUBLISH.jobs['publish-it-cdn'].outputs?.cdn_base)
        .toBe('${{ steps.cdn-ready.outputs.cdn_base }}');

      const cases: Array<{ receiptContent: string | null; status: 0 | 1 }> = [
        { receiptContent: ' 1770000000001 \n', status: 0 },
        { receiptContent: '1770000000000\n', status: 1 },
        { receiptContent: null, status: 1 },
      ];
      for (const testCase of cases) {
        if (testCase.receiptContent === null) rmSync(receipt, { force: true });
        else writeFileSync(receipt, testCase.receiptContent);
        writeFileSync(output, '');
        const result = runWorkflowBash(run, root, {
          EARLY_OUTCOME: 'success',
          RETRY_OUTCOME: 'skipped',
          EXPECTED_SOURCE_RUN_ID: SOURCE_RUN_ID,
          EXPECTED_SOURCE_SHA: SOURCE_SHA,
          EXPECTED_BUILD_ID: BUILD_ID,
          GITHUB_OUTPUT: output,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(testCase.status);
        if (testCase.status === 0) {
          const contents = readFileSync(output, 'utf8');
          expect(contents).toContain(`job_canon_source_run_id=${SOURCE_RUN_ID}\n`);
          expect(contents).toContain(`job_canon_source_sha=${SOURCE_SHA}\n`);
          expect(contents).toContain(`job_canon_build_id=${BUILD_ID}\n`);
        } else {
          expect(readFileSync(output, 'utf8')).not.toContain('job_canon_');
        }
      }

      rmSync(receipt, { force: true });
      writeFileSync(output, '');
      const failedPush = runWorkflowBash(run, root, {
        EARLY_OUTCOME: 'failure',
        RETRY_OUTCOME: 'failure',
        EXPECTED_SOURCE_RUN_ID: SOURCE_RUN_ID,
        EXPECTED_SOURCE_SHA: SOURCE_SHA,
        EXPECTED_BUILD_ID: BUILD_ID,
        GITHUB_OUTPUT: output,
      });
      expect(failedPush.status).toBe(1);
      expect(readFileSync(output, 'utf8')).not.toContain('job_canon_');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs the finalizer gate with only source-bound early or durable proof', () => {
    const gate = workflowStep('finalize-it-publish', 'job-canon-publish-gate');
    const run = String(gate.run);
    const root = mkdtempSync(join(tmpdir(), 'job-canon-final-gate-'));
    const localReceipt = join(root, 'job-canon-publish.ok');
    try {
      expect(run).not.toContain('${{');
      expect(gate.if).toBe("steps.deploy-prep-it.outcome == 'success'");
      expect(run).toContain('node scripts/ci/job-canon-publish-receipt.mjs');
      expect(run).not.toContain('RUNNER_TEMP/job-canon-publish.ok');
      expect(gate.env.EXPECTED_SOURCE_RUN_ID).toBe('${{ inputs.source_run_id }}');
      expect(gate.env.EXPECTED_SOURCE_SHA).toBe('${{ inputs.source_sha }}');
      expect(gate.env.EXPECTED_BUILD_ID).toBe('${{ needs.resolve-publish-plan.outputs.build_id }}');
      expect(gate.env.CDN_JOB_RESULT).toBe('${{ needs.publish-it-cdn.result }}');
      expect(gate.env.EARLY_SOURCE_RUN_ID).toBe('${{ needs.publish-it-cdn.outputs.job_canon_source_run_id }}');
      expect(gate.env.EARLY_SOURCE_SHA).toBe('${{ needs.publish-it-cdn.outputs.job_canon_source_sha }}');
      expect(gate.env.EARLY_BUILD_ID).toBe('${{ needs.publish-it-cdn.outputs.job_canon_build_id }}');
      expect(gate.env.DURABLE_RECEIPT_PUBLISHED).toBe('${{ needs.resolve-publish-receipts.outputs.it_cdn_published }}');
      expect(gate.env.DURABLE_SOURCE_RUN_ID).toBe('${{ needs.resolve-publish-receipts.outputs.it_cdn_source_run_id }}');
      expect(gate.env.DURABLE_SOURCE_SHA).toBe('${{ needs.resolve-publish-receipts.outputs.it_cdn_source_sha }}');
      expect(gate.env.DURABLE_BUILD_ID).toBe('${{ needs.resolve-publish-receipts.outputs.it_cdn_build_id }}');
      expect(gate.env.CDN_BASE).toBeUndefined();
      expect(gate.env.EARLY_JOB_CANON_BUILD_ID).toBeUndefined();

      // This file exists only on the test runner's local temp path and must not
      // substitute for the early job output or the source-bound durable receipt.
      writeFileSync(localReceipt, `${BUILD_ID}\n`);

      const cases: Array<{
        cdnJobResult: 'success' | 'skipped';
        earlyProof: Partial<typeof earlyProof>;
        durableReceipt: Partial<typeof durableReceipt>;
        status: 0 | 1;
        output: string;
      }> = [
        {
          cdnJobResult: 'success',
          earlyProof,
          durableReceipt: { published: 'false' },
          status: 0,
          output: `job-canon handshake closed for build ${BUILD_ID} via early-job-output`,
        },
        {
          cdnJobResult: 'skipped',
          earlyProof: {},
          durableReceipt,
          status: 0,
          output: `job-canon handshake closed for build ${BUILD_ID} via durable-receipt`,
        },
        {
          cdnJobResult: 'skipped',
          earlyProof: {},
          durableReceipt: { ...durableReceipt, published: 'false' },
          status: 1,
          output: 'durable IT CDN receipt does not prove this source run, SHA, and build',
        },
        {
          cdnJobResult: 'skipped',
          earlyProof: {},
          durableReceipt: { ...durableReceipt, sourceRunId: '43969699460' },
          status: 1,
          output: 'durable IT CDN receipt does not prove this source run, SHA, and build',
        },
        {
          cdnJobResult: 'success',
          earlyProof: { ...earlyProof, sourceSha: 'd'.repeat(40) },
          durableReceipt,
          status: 1,
          output: 'early CDN job output does not prove this source run, SHA, and build',
        },
        {
          cdnJobResult: 'skipped',
          earlyProof: {},
          durableReceipt: {},
          status: 1,
          output: 'durable IT CDN receipt does not prove this source run, SHA, and build',
        },
        {
          cdnJobResult: 'skipped',
          earlyProof: {},
          durableReceipt: { published: 'false' },
          status: 1,
          output: 'durable IT CDN receipt does not prove this source run, SHA, and build',
        },
      ];
      for (const testCase of cases) {
        const result = runWorkflowBash(run, root, {
          EXPECTED_SOURCE_RUN_ID: SOURCE_RUN_ID,
          EXPECTED_SOURCE_SHA: SOURCE_SHA,
          EXPECTED_BUILD_ID: BUILD_ID,
          CDN_JOB_RESULT: testCase.cdnJobResult,
          EARLY_SOURCE_RUN_ID: testCase.earlyProof.sourceRunId ?? '',
          EARLY_SOURCE_SHA: testCase.earlyProof.sourceSha ?? '',
          EARLY_BUILD_ID: testCase.earlyProof.buildId ?? '',
          DURABLE_RECEIPT_PUBLISHED: testCase.durableReceipt.published ?? '',
          DURABLE_SOURCE_RUN_ID: testCase.durableReceipt.sourceRunId ?? '',
          DURABLE_SOURCE_SHA: testCase.durableReceipt.sourceSha ?? '',
          DURABLE_BUILD_ID: testCase.durableReceipt.buildId ?? '',
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
      writeFileSync(join(previous, 'bi.json'), '{"same":true}');
      writeFileSync(join(current, 'bi.json'), '{"changed":true}');
      writeFileSync(join(current, 'a_.json'), '{"added":true}');
      writeFileSync(join(previous, '01.json'), '{"same":true}');
      writeFileSync(join(current, '01.json'), '{"same":true}');
      writeFileSync(join(previous, '02.json'), '{"old":true}');
      writeFileSync(join(current, '02.json'), '{"new":true}');
      writeFileSync(join(previous, 'v2', 'abc.json'), '{"removed":true}');
      writeFileSync(join(current, 'v2', 'def.json'), '{"added":true}');
      mkdirSync(join(previous, 'releases', '1001', 'v2'), { recursive: true });
      mkdirSync(join(current, 'releases', '1001', 'v2'), { recursive: true });
      writeFileSync(join(previous, 'releases', '1001', 'manifest.json'), '{"generation":"old"}');
      writeFileSync(join(current, 'releases', '1001', 'manifest.json'), '{"generation":"new"}');
      writeFileSync(join(previous, 'releases', '1001', 'v2', 'abc.json'), '{"release":"old"}');
      writeFileSync(join(current, 'releases', '1001', 'v2', 'abc.json'), '{"release":"new"}');

      expect(compareMapTrees(current, previous)).toEqual([
        'job-canon/02.json',
        'job-canon/a_.json',
        'job-canon/bi.json',
        'job-canon/releases/1001/v2/abc.json',
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
      JSON.stringify({ msg: 'Copied (new)', object: 'job-canon/bi.json' }),
      JSON.stringify({ msg: 'Copied (new)', object: 'job-canon/a_.json' }),
      JSON.stringify({ msg: 'Deleted', object: 'v2/abc.json' }),
      JSON.stringify({ msg: 'Copied (new)', object: 'job-canon/releases/1001/v2/abc.json' }),
      JSON.stringify({ msg: 'Copied (new)', object: 'job-canon/releases/1001/manifest.json' }),
      JSON.stringify({ msg: 'Unchanged skipping', object: 'job-canon/02.json' }),
      JSON.stringify({ msg: 'Updated modification time', object: 'job-canon/03.json' }),
    ].join('\n');
    expect(parseRcloneChangedKeys(log)).toEqual([
      'job-canon/01.json',
      'job-canon/a_.json',
      'job-canon/bi.json',
      'job-canon/releases/1001/v2/abc.json',
      'job-canon/v2/abc.json',
    ]);
    expect(parseRcloneChangedKeys(
      JSON.stringify({ msg: 'Copied (new)', object: 'v2/abc.json' }),
      'job-canon/releases/1001',
    )).toEqual(['job-canon/releases/1001/v2/abc.json']);
    expect(() => parseRcloneChangedKeys(
      JSON.stringify({ msg: 'Copied (new)', object: 'job-canon/releases/1002/v2/abc.json' }),
      'job-canon/releases/1001',
    )).toThrow(/outside expected job-canon target/);
    expect(() => parseRcloneChangedKeys(`${log}\npartial json`)).toThrow(/invalid rclone JSON log record/);
    expect(() => parseRcloneChangedKeys(JSON.stringify({ msg: 'Copied (new)', object: 'assets/nope.js' })))
      .toThrow(/unrecognized job-canon object/);
    expect(() => parseRcloneChangedKeys(JSON.stringify({ msg: 'Unknown operation', object: 'job-canon/01.json' })))
      .toThrow(/unrecognized rclone object record/);
    expect(() => parseRcloneChangedKeys(JSON.stringify({ msg: 'Copied (new)', object: 'job-canon/releases/latest/v2/abc.json' })))
      .toThrow(/unrecognized job-canon object/);
  });

  it.each(['b.json', 'bi0.json', 'BI.json', 'b-.json'])(
    'rejects invalid v1 bucket filename %s in tree and rclone inventories',
    (filename) => {
      const { root, current, previous } = fixtureTree();
      try {
        writeFileSync(join(current, filename), '{"invalid":true}');
        expect(() => compareMapTrees(current, previous)).toThrow(/unexpected job-canon file/);
        expect(() => parseRcloneChangedKeys(JSON.stringify({
          msg: 'Copied (new)',
          object: `job-canon/${filename}`,
        }))).toThrow(/unrecognized job-canon object/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('keeps v2 buckets on the existing three-character lowercase hex format', () => {
    expect(parseRcloneChangedKeys(JSON.stringify({ msg: 'Copied (new)', object: 'job-canon/v2/abc.json' })))
      .toEqual(['job-canon/v2/abc.json']);
    expect(() => parseRcloneChangedKeys(JSON.stringify({ msg: 'Copied (new)', object: 'job-canon/v2/ab.json' })))
      .toThrow(/unrecognized job-canon object/);
    expect(() => parseRcloneChangedKeys(JSON.stringify({ msg: 'Copied (new)', object: 'job-canon/v2/abg.json' })))
      .toThrow(/unrecognized job-canon object/);
  });

  it('accepts v1 and v2 inventory keys in the publish handshake gate', () => {
    const { root, current } = fixtureTree();
    try {
      const affectedFile = join(root, 'affected.txt');
      writeFileSync(affectedFile, [
        'job-canon/bi.json',
        'job-canon/a_.json',
        'job-canon/v2/abc.json',
      ].join('\n'));

      const result = runPublishHandshake(current, affectedFile);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('CF_API_TOKEN is required');
      expect(result.stderr).not.toContain('invalid affected job-canon key');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates a schema 3 release with 16 concurrent requests and never requests a v1 path', async () => {
    const { root, current } = fixtureTree();
    try {
      const keys: string[] = [];
      for (let index = 0; index < 40; index += 1) {
        const bucket = index.toString(16).padStart(3, '0');
        writeFileSync(join(current, 'v2', `${bucket}.json`), `{"s${index}":{"it":"/x"}}`);
        keys.push(`job-canon/v2/${bucket}.json`);
      }
      let inFlight = 0;
      let peak = 0;
      const requested: string[] = [];
      const fetchStub = (async (input: string | URL) => {
        const url = new URL(String(input));
        requested.push(url.pathname);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolveTick) => setTimeout(resolveTick, 5));
        inFlight -= 1;
        return new Response(readFileSync(join(current, url.pathname.replace(/^\/job-canon\//, ''))), { status: 200 });
      }) as typeof fetch;
      await verifyMapFreshness(keys, current, 'https://cdn.example.test', fetchStub);
      expect(requested).toHaveLength(40);
      expect(requested.every((pathname) => /^\/job-canon\/v2\/[0-9a-f]{3}\.json$/.test(pathname))).toBe(true);
      expect(peak).toBeGreaterThan(4);
      expect(peak).toBeLessThanOrEqual(16);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not report carried-forward legacy v1 shards or old releases as changed when the new release has none', () => {
    const { root, current, previous } = fixtureTree();
    try {
      for (const tree of [current, previous]) {
        mkdirSync(join(tree, 'releases', '1001'), { recursive: true });
        writeFileSync(join(tree, 'ne.json'), '{"legacy":true}');
        writeFileSync(join(tree, 'releases', '1001', 'ab.json'), '{"old":true}');
        writeFileSync(join(tree, 'releases', '1001', 'manifest.json'), '{"schemaVersion":2}');
      }
      mkdirSync(join(current, 'releases', '1002', 'v2'), { recursive: true });
      writeFileSync(join(current, 'releases', '1002', 'v2', 'abc.json'), '{"new":true}');
      writeFileSync(join(current, 'releases', '1002', 'manifest.json'), '{"schemaVersion":3}');
      expect(compareMapTrees(current, previous)).toEqual(['job-canon/releases/1002/v2/abc.json']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['BI.json', 'a-.json', 'v2/abg.json', 'v2/ab.json'])(
    'rejects invalid handshake inventory key job-canon/%s',
    (filename) => {
      const { root, current } = fixtureTree();
      try {
        const affectedFile = join(root, 'affected.txt');
        writeFileSync(affectedFile, `job-canon/${filename}\n`);

        const result = runPublishHandshake(current, affectedFile);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('invalid affected job-canon key');
        expect(result.stderr).not.toContain('CF_API_TOKEN is required');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

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
      mkdirSync(join(current, 'releases', '43874484314', 'v2'), { recursive: true });
      writeFileSync(join(current, 'releases', '43874484314', 'v2', 'abc.json'), bytes);
      const seen: string[] = [];
      const fetchImpl = async (url: string) => ({
        status: url.endsWith('deleted.json') ? 404 : 200,
        headers: { get: () => '' },
        arrayBuffer: async () => {
          seen.push(url);
          return bytes;
        },
      });
      await verifyMapFreshness(
        [
          'job-canon/01.json',
          'job-canon/v2/deleted.json',
          'job-canon/releases/43874484314/v2/abc.json',
        ],
        current,
        'https://cdn.example.test',
        fetchImpl,
      );
      expect(seen).toContain('https://cdn.example.test/job-canon/releases/43874484314/v2/abc.json');

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

  it('verifies every shard with at most 16 requests in flight and still fails on one stale shard', async () => {
    const { root, current } = fixtureTree();
    try {
      const bytes = Buffer.from('{"canonical":"/it/job/"}');
      const keys = Array.from({ length: 60 }, (_, index) => {
        const name = `${index.toString(16).padStart(3, '0')}.json`;
        writeFileSync(join(current, 'v2', name), bytes);
        return `job-canon/v2/${name}`;
      });
      let inFlight = 0;
      let peak = 0;
      const seen = new Set<string>();
      const fetchWith = (staleSuffix: string) => async (url: string) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((done) => setTimeout(done, 2));
        inFlight -= 1;
        seen.add(url);
        const body = staleSuffix && url.endsWith(staleSuffix) ? Buffer.from('{"stale":true}') : bytes;
        return { status: 200, headers: { get: () => '' }, arrayBuffer: async () => body };
      };

      await verifyMapFreshness(keys, current, 'https://cdn.example.test', fetchWith(''));
      expect(peak).toBe(16);
      expect(seen.size).toBe(keys.length);

      seen.clear();
      await expect(
        verifyMapFreshness(keys, current, 'https://cdn.example.test', fetchWith('/v2/02a.json')),
      ).rejects.toThrow('job-canon live validation failed for 1 shard(s)');
      expect(seen.size).toBe(keys.length);
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

  it('accepts the early handshake job output when the finalizer runs on another runner', () => {
    // The finalizer has no access to the CDN runner's RUNNER_TEMP. Its job
    // dependency output carries the receipt identity across the runner boundary.
    expect(resolveJobCanonPublishProof({
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      buildId: BUILD_ID,
      cdnJobResult: 'success',
      earlyProof,
      durableReceipt: { published: 'false' },
    })).toEqual({ accepted: true, source: 'early-job-output' });
  });

  it('accepts a skipped CDN job only with the exact durable source and build receipt', () => {
    expect(resolveJobCanonPublishProof({
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      buildId: BUILD_ID,
      cdnJobResult: 'skipped',
      earlyProof: {},
      durableReceipt,
    })).toEqual({ accepted: true, source: 'durable-receipt' });
  });

  it.each([
    ['missing', { published: 'false', ...earlyProof }],
    ['wrong source run', { ...durableReceipt, sourceRunId: '43969699460' }],
    ['wrong source SHA', { ...durableReceipt, sourceSha: 'd'.repeat(40) }],
    ['old build', { ...durableReceipt, buildId: '1770000000000' }],
    ['missing build', { ...durableReceipt, buildId: '' }],
  ])('rejects a %s durable receipt', (_case, receipt) => {
    expect(resolveJobCanonPublishProof({
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      buildId: BUILD_ID,
      cdnJobResult: 'skipped',
      earlyProof: {},
      durableReceipt: receipt,
    }).accepted).toBe(false);
  });

  it('does not fall back to a durable receipt after a successful but mismatched early job', () => {
    expect(resolveJobCanonPublishProof({
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      buildId: BUILD_ID,
      cdnJobResult: 'success',
      earlyProof: { ...earlyProof, buildId: '1770000000000' },
      durableReceipt,
    }).accepted).toBe(false);
  });

  it('does not accept CDN_BASE by itself and binds each workflow signal to its source', () => {
    const baseOnly = resolveJobCanonPublishProof({
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      buildId: BUILD_ID,
      cdnJobResult: 'skipped',
      cdnBase: 'https://cdn.frontaliereticino.ch',
      durableReceipt: { published: 'false' },
    });
    expect(baseOnly.accepted).toBe(false);

    const cdn = PUBLISH.jobs['publish-it-cdn'];
    expect(cdn.outputs?.job_canon_source_run_id).toBe('${{ steps.cdn-ready.outputs.job_canon_source_run_id }}');
    expect(cdn.outputs?.job_canon_source_sha).toBe('${{ steps.cdn-ready.outputs.job_canon_source_sha }}');
    expect(cdn.outputs?.job_canon_build_id).toBe('${{ steps.cdn-ready.outputs.job_canon_build_id }}');
    const finalizerGate = workflowStep('finalize-it-publish', 'job-canon-publish-gate');
    expect(finalizerGate.env.CDN_JOB_RESULT).toBe('${{ needs.publish-it-cdn.result }}');
    expect(finalizerGate.env.DURABLE_RECEIPT_PUBLISHED).toBe('${{ needs.resolve-publish-receipts.outputs.it_cdn_published }}');
    expect(finalizerGate.run).toContain('node scripts/ci/job-canon-publish-receipt.mjs');
    expect(finalizerGate.run).not.toContain('RUNNER_TEMP/job-canon-publish.ok');
    expect(finalizerGate.env.CDN_BASE).toBeUndefined();
  });
});
