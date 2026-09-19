// @vitest-environment node
/**
 * Unit tests for the content-addressable cache fingerprint exported by
 * scripts/assemble-jobs-dataset.mjs.
 *
 * These tests validate that:
 *   1. The fingerprint is stable across calls when slice files are unchanged.
 *   2. The fingerprint is INVARIANT under mtime changes (content hashing —
 *      `actions/checkout` resets mtime on every CI run, so an mtime-sensitive
 *      key would always MISS).
 *   3. The fingerprint changes when any slice file's content changes.
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
  readFileSync,
  realpathSync,
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
let listAssembleCodeClosure;
let computeAssembleCacheKey;

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

  // scripts/jobs-url-helper.mjs (transitively imported via crawler-template.mjs)
  // resolves canton URL sections via the shared build-plugins module + the two
  // canton reference JSON files at module-load time — mirror that slice of the
  // real repo layout too, or the import fails inside the sandbox.
  mkdirSync(path.join(tmpRoot, 'build-plugins', 'shared'), { recursive: true });
  cpSync(
    path.join(REPO_ROOT, 'build-plugins', 'shared', 'cantonResolvers.mjs'),
    path.join(tmpRoot, 'build-plugins', 'shared', 'cantonResolvers.mjs'),
  );
  mkdirSync(path.join(tmpRoot, 'data'), { recursive: true });
  cpSync(
    path.join(REPO_ROOT, 'data', 'canton-url-slugs.json'),
    path.join(tmpRoot, 'data', 'canton-url-slugs.json'),
  );
  cpSync(
    path.join(REPO_ROOT, 'data', 'canton-municipalities.json'),
    path.join(tmpRoot, 'data', 'canton-municipalities.json'),
  );

  // Pre-create empty slice directories so existsSync passes
  mkdirSync(path.join(tmpRoot, 'data', 'jobs', 'by-crawler'), { recursive: true });
  mkdirSync(path.join(tmpRoot, 'data', 'jobs', 'expired', 'by-crawler'), { recursive: true });
  mkdirSync(path.join(tmpRoot, 'data', 'jobs-crawler-summaries', 'by-crawler'), { recursive: true });

  tmpScriptUrl = pathToFileURL(path.join(tmpRoot, 'scripts', 'assemble-jobs-dataset.mjs')).href;
  const mod = await import(tmpScriptUrl);
  computeAssembleInputFingerprint = mod.computeAssembleInputFingerprint;
  listAssembleCodeClosure = mod.listAssembleCodeClosure;
  computeAssembleCacheKey = mod.computeAssembleCacheKey;
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

  it('is INVARIANT under mtime changes (content hashing survives checkout mtime reset)', () => {
    const filePath = writeSlice('data/jobs/by-crawler/test-mtime.json', '{"x":1}');
    const fpBefore = computeAssembleInputFingerprint();
    // Bump mtime by 10 seconds in the future — simulates `actions/checkout`
    // rewriting mtimes to checkout time on every CI run.
    const future = new Date(Date.now() + 10_000);
    utimesSync(filePath, future, future);
    const fpAfter = computeAssembleInputFingerprint();
    expect(fpAfter).toEqual(fpBefore);
  });

  it('changes when a slice file content changes (same length)', () => {
    writeSlice('data/jobs/by-crawler/test-content.json', '{"y":1}');
    const fpBefore = computeAssembleInputFingerprint();
    writeSlice('data/jobs/by-crawler/test-content.json', '{"y":2}');
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

  it('ignores cache and cleanup-orphan JSON files in every input directory', () => {
    const fpBefore = computeAssembleInputFingerprint();
    for (const dir of [
      'data/jobs/by-crawler',
      'data/jobs/expired/by-crawler',
      'data/jobs-crawler-summaries/by-crawler',
    ]) {
      writeSlice(`${dir}/fingerprint-locale-cache.json`, '{"decoy":true}');
      writeSlice(`${dir}/fingerprint.json.cleanup-tmp.json`, '{"decoy":true}');
    }
    const fpAfter = computeAssembleInputFingerprint();
    expect(fpAfter).toEqual(fpBefore);
  });
});

// The send-* workflows mail the restored data/jobs.json to subscribers: a key
// that ignored the assembler's own code or its aux data files would replay the
// output of the previous assembler after a merged fix, until the next slice
// commit. These pin that every such input moves the key.
describe('computeAssembleInputFingerprint — non-slice inputs', () => {
  it('changes when a module of the local import closure changes', () => {
    const lib = path.join(tmpRoot, 'scripts', 'lib', 'compare-expired-at.mjs');
    // realpath: on macOS tmpdir() is /var/… while module URLs resolve to /private/var/….
    expect(listAssembleCodeClosure()).toContain(realpathSync(lib));
    const fpBefore = computeAssembleInputFingerprint();
    writeFileSync(lib, `${readFileSync(lib, 'utf8')}\n// touched\n`, 'utf8');
    expect(computeAssembleInputFingerprint()).not.toEqual(fpBefore);
  });

  it('changes when an aux data input changes, appears or disappears', () => {
    const fp0 = computeAssembleInputFingerprint();
    writeSlice('data/job-canton-pins.json', '{"a":"TI"}');
    const fp1 = computeAssembleInputFingerprint();
    writeSlice('data/job-canton-pins.json', '{"a":"GR"}');
    const fp2 = computeAssembleInputFingerprint();
    rmSync(path.join(tmpRoot, 'data', 'job-canton-pins.json'));
    const fp3 = computeAssembleInputFingerprint();
    expect(new Set([fp0, fp1, fp2]).size).toBe(3);
    expect(fp3).toEqual(fp0);
  });

  it('changes when a file inside an aux data DIRECTORY changes', () => {
    writeSlice('data/orphan-enriched-data/part-00.json', '[]');
    const fpBefore = computeAssembleInputFingerprint();
    writeSlice('data/orphan-enriched-data/part-00.json', '[{"slug":"x"}]');
    expect(computeAssembleInputFingerprint()).not.toEqual(fpBefore);
  });

  it('changes when package-lock.json changes (npm dependencies)', () => {
    writeSlice('package-lock.json', '{"lockfileVersion":3}');
    const fpBefore = computeAssembleInputFingerprint();
    writeSlice('package-lock.json', '{"lockfileVersion":3,"x":1}');
    expect(computeAssembleInputFingerprint()).not.toEqual(fpBefore);
  });

  it('follows dynamic imports and worker entry points', () => {
    const closure = listAssembleCodeClosure();
    const root = realpathSync(tmpRoot);
    expect(closure).toContain(path.join(root, 'scripts', 'reconcile-job-slugs.mjs'));
    expect(closure).toContain(path.join(root, 'scripts', 'lib', 'parse-job-slices-worker.mjs'));
  });

  it('keys the run mode so a --no-summaries or --stats snapshot is never restored for a default run', () => {
    const fp = computeAssembleInputFingerprint();
    expect(computeAssembleCacheKey().cacheKey).toBe(`${fp}_nostats`);
    expect(computeAssembleCacheKey({ withStats: true }).cacheKey).toBe(`${fp}_stats`);
    expect(computeAssembleCacheKey({ withSummaries: false }).cacheKey).toBe(`${fp}_nostats_nosummaries`);
  });
});
