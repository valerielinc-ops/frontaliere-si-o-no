import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  IncrementalManifest,
  canonicalizeInput,
  computeInputHash,
  computeInputFingerprint,
  verifyRuntimeInputExclusion,
} from '../../build-plugins/shared/incrementalManifest.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../..');
const REPORT = path.join(ROOT, 'scripts/ci/incremental-manifest-report.mjs');
const PREVIOUS = path.join(ROOT, 'tests/fixtures/incremental-manifest/previous.json');
const CURRENT = path.join(ROOT, 'tests/fixtures/incremental-manifest/current.json');

describe('incremental manifest input contract', () => {
  it('canonicalizes object keys independently of insertion order', () => {
    const first = canonicalizeInput({ z: 1, a: { y: true, x: ['one', 2] } });
    const second = canonicalizeInput({ a: { x: ['one', 2], y: true }, z: 1 });
    expect(first).toBe(second);
    expect(computeInputFingerprint({ z: 1, a: 2 })).toBe(computeInputFingerprint({ a: 2, z: 1 }));
  });

  it('excludes build and generation metadata from the hash', () => {
    expect(verifyRuntimeInputExclusion()).toBe(true);
  });

  it('changes the hash when the template version changes', () => {
    const input = { slug: 'muratore', title: 'Muratore' };
    expect(computeInputHash(input, 'active-job', 'active-job@1'))
      .not.toBe(computeInputHash(input, 'active-job', 'active-job@2'));
  });

  it('writes sorted entries and counters outside dist', () => {
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
      const written = JSON.parse(fs.readFileSync(target, 'utf8'));
      expect(path.relative(tempRoot, target)).toBe('.cache/incremental-manifest/it.json');
      expect(written.entries.map((entry: { path: string }) => entry.path)).toEqual([
        'cerca-lavoro-ticino/alfa/',
        'cerca-lavoro-ticino/zeta/',
      ]);
      expect(written.counts).toMatchObject({
        total: 2,
        byKind: { 'active-job': 1, 'expired-soft-landing': 1 },
      });
      expect(written.entries[0].sourceVersion).toBe('input@1');
      expect(written).not.toHaveProperty('generatedAt');
      expect(fs.readFileSync(target, 'utf8')).toBe(fs.readFileSync(secondTarget, 'utf8'));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(secondRoot, { recursive: true, force: true });
    }
  });
});

describe('incremental manifest report', () => {
  it('prints hits, misses, collisions, and added/removed paths from fixtures', () => {
    const output = execFileSync(process.execPath, [REPORT, PREVIOUS, CURRENT], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(output).toContain('| active-job | 1 | 1 | 0 | 0 |');
    expect(output).toContain('| expired-soft-landing | 0 | 1 | 0 | 0 |');
    expect(output).toContain('| cross-locale-reconciliation | 0 | 0 | 1 | 0 |');
    expect(output).toContain('Collisioni (stesso path, input canonico uguale, inputHash diverso): 1');
    expect(output).toContain('cerca-lavoro-ticino/collisione/');
    expect(output).toContain('Path aggiunti (1):');
    expect(output).toContain('cerca-lavoro-ticino/riconciliazione/');
    expect(output).toContain('Path rimossi (1):');
    expect(output).toContain('cerca-lavoro-ticino/vecchio-slug/');
    expect(output).toContain('Runtime fields esclusi dall’input: OK');
  });
});
