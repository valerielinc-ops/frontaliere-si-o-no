import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
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
const PUBLISH = YAML.parse(PUBLISH_YML) as any;
const SOURCE_RUN_ID = '43969699461';
const SOURCE_SHA = 'c'.repeat(40);
const BUILD_ID = '1770000000001';
const earlyProof = { sourceRunId: SOURCE_RUN_ID, sourceSha: SOURCE_SHA, buildId: BUILD_ID };
const durableReceipt = { published: 'true', ...earlyProof };

function fixtureTree() {
  const root = mkdtempSync(join(tmpdir(), 'job-canon-handshake-'));
  const current = join(root, 'current');
  const previous = join(root, 'previous');
  mkdirSync(join(current, 'v2'), { recursive: true });
  mkdirSync(join(previous, 'v2'), { recursive: true });
  return { root, current, previous };
}

describe('job-canon publication handshake', () => {
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
    expect(cdn.outputs.job_canon_source_run_id).toBe('${{ steps.cdn-ready.outputs.job_canon_source_run_id }}');
    expect(cdn.outputs.job_canon_source_sha).toBe('${{ steps.cdn-ready.outputs.job_canon_source_sha }}');
    expect(cdn.outputs.job_canon_build_id).toBe('${{ steps.cdn-ready.outputs.job_canon_build_id }}');
    const finalizerGate = PUBLISH.jobs['finalize-it-publish'].steps.find((step: any) => step.name === 'Require closed job-canon handshake before Pages artifact');
    expect(finalizerGate.env.CDN_JOB_RESULT).toBe('${{ needs.publish-it-cdn.result }}');
    expect(finalizerGate.env.DURABLE_RECEIPT_PUBLISHED).toBe('${{ needs.resolve-publish-receipts.outputs.it_cdn_published }}');
    expect(finalizerGate.run).toContain('node scripts/ci/job-canon-publish-receipt.mjs');
    expect(finalizerGate.run).not.toContain('RUNNER_TEMP/job-canon-publish.ok');
    expect(finalizerGate.env.CDN_BASE).toBeUndefined();
  });
});
