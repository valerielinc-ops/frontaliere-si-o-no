// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const consumers = [
  ['repair-unicode-escape-titles.mjs', 'listSliceFilePaths', [
    'listSliceFilePaths(ACTIVE_DIR)',
    'listSliceFilePaths(EXPIRED_DIR)',
  ]],
  ['migrate-previous-slugs-to-locale-aware.mjs', 'listSliceFileNames', [
    'listSliceFileNames(SLICES_DIR)',
    'listSliceFileNames(EXPIRED_DIR)',
  ]],
  ['migrate-umantis-registry-fingerprints.mjs', 'listSliceFileNames', [
    'listSliceFileNames(dir)',
  ]],
] as const;

describe('crawler-slice repair and migration consumers', () => {
  it.each(consumers)('%s delegates slice discovery to %s', (file, _helper, calls) => {
    const source = readFileSync(path.join(ROOT, 'scripts', file), 'utf8');
    expect(source).toContain("from './lib/crawler-slice-files.mjs'");
    for (const call of calls) expect(source).toContain(call);
  });
});
