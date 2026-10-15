import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listJobsSeoAdapterFiles,
  listJobsSeoExpiredSliceFiles,
} from '../../build-plugins/shared/jobsSeoDeterministicInputs';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Jobs SEO deterministic directory inputs', () => {
  it('sorts expired slices and ignores scratch companions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-seo-slices-'));
    roots.push(root);
    for (const name of [
      'zeta.json',
      'alpha.json',
      'middle.json',
      'alpha-locale-cache.json',
      'zeta.cleanup-tmp.json',
    ]) fs.writeFileSync(path.join(root, name), '[]');

    expect(listJobsSeoExpiredSliceFiles(root)).toEqual([
      'alpha.json',
      'middle.json',
      'zeta.json',
    ]);
  });

  it('sorts adapter JSON files independently of creation order', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-seo-adapters-'));
    roots.push(root);
    for (const name of ['zeta.json', 'alpha.json', 'middle.json', 'README.md']) {
      fs.writeFileSync(path.join(root, name), '{}');
    }

    expect(listJobsSeoAdapterFiles(root)).toEqual([
      'alpha.json',
      'middle.json',
      'zeta.json',
    ]);
  });
});
