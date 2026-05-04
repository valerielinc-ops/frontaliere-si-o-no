// @vitest-environment node
/**
 * Unit tests for the content-addressable cache fingerprint exported by
 * scripts/assemble-jobs-dataset.mjs.
 *
 * These tests validate that:
 *   1. The fingerprint is stable across calls when slice files are unchanged.
 *   2. The fingerprint changes when any slice file's mtime changes.
 *   3. The fingerprint changes when any slice file's size changes.
 *   4. The fingerprint changes when a new slice file is added.
 *   5. The fingerprint changes when a slice file is removed.
 *
 * The script reads the slice directories relative to its own location
 * (data/jobs/by-crawler, data/jobs/expired/by-crawler,
 * data/jobs-crawler-summaries/by-crawler under the repo root). Since we can't
 * easily redirect those constants, the tests exercise the function in a
 * temp checkout: we copy the script under a tmp dir so its `ROOT` resolves
 * to that tmp dir, then write controlled slice files there.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
  cpSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REAL_SCRIPT = path.join(REPO_ROOT, 'scripts', 'assemble-jobs-dataset.mjs');

let tmpRoot;
let tmpScriptUrl;
let computeAssembleInputFingerprint;

beforeAll(async () => {
  // Build a minimal repo-shaped tmp dir so the script's `ROOT = path.resolve(__dirname, '..')`
  // resolves to our sandbox. We need scripts/, data/, and the script's own
  // import dependencies. Easiest: copy the entire scripts/ tree (it's source-only
  // and small) so relative imports inside the script all resolve correctly.
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'assemble-jobs-cache-'));
  mkdirSync(path.join(tmpRoot, 'scripts'), { recursive: true });

  // Copy scripts/ directory recursively so all relative imports work
  cpSync(
    path.join(REPO_ROOT, 'scripts'),
    path.join(tmpRoot, 'scripts'),
    { recursive: true },
  );

  // Pre-create empty slice directories so existsSync passes
  mkdirSync(path.join(tmpRoot, 'data', 'jobs', 'by-crawler'), { recursive: true });
  mkdirSync(path.join(tmpRoot, 'data', 'jobs', 'expired', 'by-crawler'), { recursive: true });
  mkdirSync(path.join(tmpRoot, 'data', 'jobs-crawler-summaries', 'by-crawler'), { recursive: true });

  tmpScriptUrl = pathToFileURL(path.join(tmpRoot, 'scripts', 'assemble-jobs-dataset.mjs')).href;
  const mod = await import(tmpScriptUrl);
  computeAssembleInputFingerprint = mod.computeAssembleInputFingerprint;
});

afterAll(() => {
  if (tmpRoot && existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

function writeSlice(relPath, contents) {
  const abs = path.join(tmpRoot, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, contents, 'utf8');
  return abs;
}

describe('computeAssembleInputFingerprint', () => {
  it('returns a deterministic 16-char hex string', () => {
    const fp = computeAssembleInputFingerprint();
    expect(typeof fp).toBe('string');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable across calls when slice files are unchanged', () => {
    writeSlice('data/jobs/by-crawler/test-a.json', '{"a":1}');
    writeSlice('data/jobs/by-crawler/test-b.json', '{"b":2}');
    const fp1 = computeAssembleInputFingerprint();
    const fp2 = computeAssembleInputFingerprint();
    expect(fp1).toEqual(fp2);
  });

  it('changes when a slice file mtime changes', () => {
    const filePath = writeSlice('data/jobs/by-crawler/test-mtime.json', '{"x":1}');
    const fpBefore = computeAssembleInputFingerprint();
    // Bump mtime by 10 seconds in the future
    const future = new Date(Date.now() + 10_000);
    utimesSync(filePath, future, future);
    const fpAfter = computeAssembleInputFingerprint();
    expect(fpAfter).not.toEqual(fpBefore);
  });

  it('changes when a slice file size changes', () => {
    writeSlice('data/jobs/by-crawler/test-size.json', '{"y":1}');
    const fpBefore = computeAssembleInputFingerprint();
    writeSlice('data/jobs/by-crawler/test-size.json', '{"y":1,"z":2}');
    const fpAfter = computeAssembleInputFingerprint();
    expect(fpAfter).not.toEqual(fpBefore);
  });

  it('changes when a new slice file is added', () => {
    const fpBefore = computeAssembleInputFingerprint();
    writeSlice('data/jobs-crawler-summaries/by-crawler/test-new.json', '{"k":"v"}');
    const fpAfter = computeAssembleInputFingerprint();
    expect(fpAfter).not.toEqual(fpBefore);
  });

  it('changes when a slice file is removed', () => {
    const filePath = writeSlice('data/jobs/expired/by-crawler/test-rm.json', '{"e":1}');
    const fpBefore = computeAssembleInputFingerprint();
    rmSync(filePath);
    const fpAfter = computeAssembleInputFingerprint();
    expect(fpAfter).not.toEqual(fpBefore);
  });

  it('ignores non-.json files in the slice directories', () => {
    const fpBefore = computeAssembleInputFingerprint();
    writeSlice('data/jobs/by-crawler/README.md', 'ignore me');
    writeSlice('data/jobs/by-crawler/.gitkeep', '');
    const fpAfter = computeAssembleInputFingerprint();
    expect(fpAfter).toEqual(fpBefore);
  });
});
