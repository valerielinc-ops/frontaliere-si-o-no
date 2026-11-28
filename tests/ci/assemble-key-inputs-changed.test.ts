import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSEMBLE_SLICE_DIRS,
  findChangedAssembleKeyInput,
} from '../../scripts/ci/assemble-key-inputs-changed.mjs';
import {
  ASSEMBLE_AUX_DATA_INPUTS,
  listAssembleCodeClosure,
} from '../../scripts/assemble-jobs-dataset.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SOURCE = readFileSync(path.join(ROOT, 'scripts/assemble-jobs-dataset.mjs'), 'utf8');
const codeFiles = listAssembleCodeClosure().map((abs) => path.relative(ROOT, abs).split(path.sep).join('/'));

const probe = (...changedPaths: string[]) => findChangedAssembleKeyInput({
  changedPaths,
  codeFiles,
  auxInputs: ASSEMBLE_AUX_DATA_INPUTS,
});

describe('findChangedAssembleKeyInput', () => {
  it.each([
    ['a file of the code closure', 'scripts/assemble-jobs-dataset.mjs'],
    ['a crawler slice', 'data/jobs/by-crawler/example.json'],
    ['an expired slice', 'data/jobs/expired/by-crawler/example.json'],
    ['a summaries slice', 'data/jobs-crawler-summaries/by-crawler/example.json'],
    ['an exact aux file', 'data/job-canton-pins.json'],
    ['a file inside an aux directory', 'data/url-first-seen/part-1.json'],
    ['package-lock.json', 'package-lock.json'],
  ])('flags %s', (_label, file) => {
    expect(probe('README.md', file)).toEqual({ changed: true, path: file });
  });

  it.each([
    ['an output of the assembler', 'data/jobs.json'],
    ['a test', 'tests/x.test.ts'],
    ['the workflow', '.github/workflows/tests.yml'],
    ['a sibling sharing only a textual prefix', 'data/url-first-seen-altro.json'],
    ['a scratch file next to the slices', 'data/jobs/by-crawler/example-locale-cache.json'],
    ['a nested file below a slice directory', 'data/jobs/by-crawler/sub/example.json'],
  ])('ignores %s', (_label, file) => {
    expect(probe(file)).toEqual({ changed: false, path: null });
  });

  it('returns the first intersecting path and handles an empty diff', () => {
    expect(probe('a.md', 'package-lock.json', 'data/job-canton-pins.json').path).toBe('package-lock.json');
    expect(probe()).toEqual({ changed: false, path: null });
  });
});

describe('slice directories mirror the assembler', () => {
  const constants = ['JOBS_SLICES_DIR', 'EXPIRED_SLICES_DIR', 'SUMMARIES_SLICES_DIR'];

  it('defines the three constants exactly as ASSEMBLE_SLICE_DIRS lists them', () => {
    const declared = [...SOURCE.matchAll(/^const (\w+_SLICES_DIR) = path\.join\(ROOT, ([^)]*)\);/gm)]
      .map((m) => [m[1], m[2].split(',').map((p) => p.trim().replace(/^'|'$/g, '')).join('/')]);
    expect(declared.map(([name]) => name).sort()).toEqual([...constants].sort());
    expect(declared.map(([, dir]) => dir).sort()).toEqual([...ASSEMBLE_SLICE_DIRS].sort());
  });

  it('hashes exactly those three directories and no other', () => {
    const body = SOURCE.slice(SOURCE.indexOf('export function computeAssembleInputFingerprint'));
    const match = body.match(/const dirs = \[([^\]]*)\];/);
    expect(match).not.toBeNull();
    const used = match![1].split(',').map((s) => s.trim()).filter(Boolean);
    expect([...used].sort()).toEqual([...constants].sort());
  });

  it('knows the real closure', () => {
    expect(codeFiles).toContain('scripts/assemble-jobs-dataset.mjs');
    expect(codeFiles).toContain('scripts/lib/crawler-slice-files.mjs');
  });
});
