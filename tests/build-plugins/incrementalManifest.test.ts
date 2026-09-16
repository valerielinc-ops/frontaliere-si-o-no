import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildMinimalJobInput,
  IncrementalManifest,
  INCREMENTAL_MANIFEST_ENABLED,
  MANIFEST_FORMAT,
  MANIFEST_VERSION,
  canonicalizeInput,
  computeInputHash,
  verifyRuntimeInputExclusion,
} from '../../build-plugins/shared/incrementalManifest.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../..');
const REPORT = path.join(ROOT, 'scripts/ci/incremental-manifest-report.mjs');
const PREVIOUS = path.join(ROOT, 'tests/fixtures/incremental-manifest/previous.jsonl');
const CURRENT = path.join(ROOT, 'tests/fixtures/incremental-manifest/current.jsonl');

describe('incremental manifest input contract', () => {
  it('canonicalizes object keys independently of insertion order', () => {
    const first = canonicalizeInput({ z: 1, a: { y: true, x: ['one', 2] } });
    const second = canonicalizeInput({ a: { x: ['one', 2], y: true }, z: 1 });
    expect(first).toBe(second);
  });

  it('projects only stable job identity and related job ids', () => {
    const input = buildMinimalJobInput(
      { id: 'job-1', updatedAt: 'v2', title: 'large source object' },
      'de',
      'maurer-v2',
      ['related-1', 'related-2'],
    );
    expect(input).toEqual({
      jobId: 'job-1',
      jobVersion: 'v2',
      locale: 'de',
      slug: 'maurer-v2',
      relatedJobIds: ['related-1', 'related-2'],
    });
    expect(computeInputHash(input, 'active-job')).not.toBe(
      computeInputHash(buildMinimalJobInput({ id: 'job-1', updatedAt: 'v3' }, 'de', 'maurer-v2', ['related-1', 'related-2']), 'active-job'),
    );
  });

  it('keeps the shadow feature opt-in by default', () => {
    expect(INCREMENTAL_MANIFEST_ENABLED).toBe(false);
  });

  it('excludes build and generation metadata from the hash', () => {
    expect(verifyRuntimeInputExclusion()).toBe(true);
  });

  it('changes the hash when the template version changes', () => {
    const input = { slug: 'muratore', title: 'Muratore' };
    expect(computeInputHash(input, 'active-job', 'active-job@1'))
      .not.toBe(computeInputHash(input, 'active-job', 'active-job@2'));
  });

  it('writes compact, grouped JSONL entries and counters outside dist', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-manifest-test-'));
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-manifest-test-'));
    try {
      const manifest = new IncrementalManifest('it');
      manifest.register('/cerca-lavoro-ticino/zeta/', 'active-job', { slug: 'zeta' });
      manifest.register('/cerca-lavoro-ticino/alfa/', 'expired-soft-landing', { slug: 'alfa' });
      const target = manifest.write(tempRoot);
      const secondManifest = new IncrementalManifest('it');
      secondManifest.register('/cerca-lavoro-ticino/alfa/', 'expired-soft-landing', { slug: 'alfa' });
      secondManifest.register('/cerca-lavoro-ticino/zeta/', 'active-job', { slug: 'zeta' });
      const secondTarget = secondManifest.write(secondRoot);
      const lines = fs.readFileSync(target, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(path.relative(tempRoot, target)).toBe('.cache/incremental-manifest/it.jsonl');
      expect(lines[0]).toEqual({
        type: 'header',
        manifestVersion: MANIFEST_VERSION,
        format: MANIFEST_FORMAT,
        locale: 'it',
      });
      expect(lines.filter((line) => line.type === 'kind')).toEqual([
        { type: 'kind', kind: 'active-job', templateVersion: 'active-job@1', sourceVersion: 'input@1', state: 'live' },
        { type: 'kind', kind: 'expired-soft-landing', templateVersion: 'expired-soft-landing@1', sourceVersion: 'input@1', state: 'live' },
      ]);
      const entries = lines.filter((line) => !line.type);
      expect(entries.map((entry: { path: string }) => entry.path)).toEqual([
        'cerca-lavoro-ticino/zeta/',
        'cerca-lavoro-ticino/alfa/',
      ]);
      expect(entries.every((entry) => Object.keys(entry).sort().join(',') === 'hash,path')).toBe(true);
      expect(lines.at(-1)).toMatchObject({
        type: 'footer',
        counts: {
          total: 2,
          byKind: { 'active-job': 1, 'expired-soft-landing': 1 },
        },
      });
      expect(manifest.toJSON().kinds['active-job']).toEqual({
        templateVersion: 'active-job@1',
        sourceVersion: 'input@1',
        state: 'live',
      });
      expect(fs.readFileSync(target, 'utf8')).not.toContain('inputFingerprint');
      expect(fs.readFileSync(target, 'utf8')).toBe(fs.readFileSync(secondTarget, 'utf8'));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it('measures 10k register calls on a fixed minimal workload', () => {
    const manifest = new IncrementalManifest('it');
    const started = performance.now();
    for (let i = 0; i < 10_000; i += 1) {
      manifest.register(`/bench/${i}/`, 'active-job', {
        jobId: `job-${i}`,
        jobVersion: 'fixture-v1',
        locale: 'it',
        slug: `job-${i}`,
        relatedJobIds: [],
      });
    }
    const elapsedMs = performance.now() - started;
    console.log(`incrementalManifest register benchmark: ${elapsedMs.toFixed(3)} ms per 10k register()`);
    expect(manifest.toJSON().counts.total).toBe(10_000);
    expect(elapsedMs).toBeGreaterThan(0);
  });
});

describe('incremental manifest report', () => {
  it('reads JSONL line-by-line and prints hits, misses, and added/removed paths', () => {
    const output = execFileSync(process.execPath, [REPORT, PREVIOUS, CURRENT], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(output).toContain('| active-job | 1 | 1 | 0 | 0 |');
    expect(output).toContain('| expired-soft-landing | 0 | 1 | 0 | 0 |');
    expect(output).toContain('| legacy-slug-bridge | 0 | 0 | 0 | 1 |');
    expect(output).toContain('| cross-locale-reconciliation | 0 | 0 | 1 | 0 |');
    expect(output).toContain('Collisioni (fingerprint per-entry omesso): non calcolate');
    expect(output).toContain('Path aggiunti (1):');
    expect(output).toContain('cerca-lavoro-ticino/riconciliazione/');
    expect(output).toContain('Path rimossi (1):');
    expect(output).toContain('cerca-lavoro-ticino/vecchio-slug/');
    expect(output).toContain('Runtime fields esclusi dall’input: OK');
  });
});
