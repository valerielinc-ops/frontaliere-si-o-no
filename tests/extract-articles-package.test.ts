import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractArticlesPackage, ARTICLES_PACKAGE_SOURCE_DIR } from '../scripts/extract-articles-package.mjs';

/**
 * Extraction proof — issue #4881 Fase 6, Step 4.
 *
 * `scripts/extract-articles-package.mjs` copies packages/articles/ into a
 * standalone directory meant to become the root of a separate
 * `frontaliere-articles` repo (consumed via
 * `npm install github:valerielinc-ops/frontaliere-articles#<sha>`, no
 * registry). This test runs the real script against a real fresh temp
 * directory and asserts the copy is byte-for-byte identical to its source
 * (`diff -rq` empty output) — proof the extraction loses or alters nothing,
 * not just that it "ran without throwing".
 */

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
});

function countFiles(dir: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) count += countFiles(full);
    else count += 1;
  }
  return count;
}

describe('extract-articles-package script (issue #4881 Fase 6, Step 4)', () => {
  it('copies packages/articles/ into a fresh temp dir with an empty byte-diff', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-articles-extract-'));
    // Exercise the "target dir does not exist yet" branch, not just "exists and empty".
    tmpDir = path.join(parent, 'frontaliere-articles');
    expect(fs.existsSync(tmpDir)).toBe(false);

    extractArticlesPackage(tmpDir);

    expect(fs.existsSync(tmpDir)).toBe(true);

    const diffResult = spawnSync('diff', ['-rq', ARTICLES_PACKAGE_SOURCE_DIR, tmpDir], { encoding: 'utf-8' });
    expect(diffResult.stdout.trim()).toBe('');
    expect(diffResult.stderr.trim()).toBe('');
    expect(diffResult.status).toBe(0);

    // Belt-and-suspenders: diff -rq matching is already conclusive, but also
    // assert file counts agree so a pathological "diff considers 0 files"
    // failure mode (e.g. a typo'd source path) can't make this vacuously pass.
    const sourceCount = countFiles(ARTICLES_PACKAGE_SOURCE_DIR);
    const targetCount = countFiles(tmpDir);
    expect(sourceCount).toBeGreaterThan(1000);
    expect(targetCount).toBe(sourceCount);
  });

  it('refuses to extract into an existing non-empty directory', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-articles-extract-nonempty-'));
    fs.writeFileSync(path.join(tmpDir, 'placeholder.txt'), 'not empty');

    expect(() => extractArticlesPackage(tmpDir!)).toThrow(/already exists and is not empty/);
  });
});
