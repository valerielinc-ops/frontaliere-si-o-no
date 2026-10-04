/**
 * Tree lint for the bounded stream readers (FU-2026-09-29-004, site issue 10283).
 *
 * A body reader keeps each chunk until it concatenates them. The chunk must be
 * an independent copy of its BYTES:
 * - a reader may hand back the same buffer on every read (#7483), so a chunk
 *   kept by reference ends up rewritten by the next read;
 * - over a bare ArrayBuffer, `new Uint8Array(value)` and `Buffer.from(value)`
 *   are views on the producer's memory, not copies, and `target.set(value, n)`
 *   copies nothing at all (an ArrayBuffer has no `length`).
 *
 * The forms below are the ones that looked like a copy and were not. The
 * guarded form `value instanceof ArrayBuffer ? new Uint8Array(value) : …`
 * (a view that is then copied) is allowed. Only files that read a stream
 * (`reader.read()`) are scanned, and only the reader's `value` binding.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCANNED_DIRS = ['scripts', 'functions/src', 'build-plugins', 'services', '.github/corpus-workflows'];
const SOURCE_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.ts']);
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage']);

const UNSAFE_CHUNK_FORMS: Array<[string, RegExp]> = [
  ['Buffer.from(value) shares an ArrayBuffer', /(?<!instanceof ArrayBuffer\s*\?\s*)Buffer\.from\(value\)/g],
  ['new Uint8Array(value) is a view over an ArrayBuffer', /(?<!instanceof ArrayBuffer\s*\?\s*)new Uint8Array\(value\)/g],
  ['.set(value, …) copies nothing from an ArrayBuffer', /\.set\(value,/g],
  ['chunks.push(value) keeps the reader buffer by reference', /chunks\.push\(value\)/g],
];

function* sourceFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* sourceFiles(full);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

function unsafeChunkForms(source: string): string[] {
  if (!/reader\.read\(\)/.test(source)) return [];
  const lines = source.split('\n');
  const found: string[] = [];
  for (const [label, pattern] of UNSAFE_CHUNK_FORMS) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split('\n').length;
      // Comments may name the unsafe form to explain the copy next to them.
      if (/^\s*(\/\/|\/\*|\*)/.test(lines[line - 1])) continue;
      found.push(`${line}: ${label}`);
    }
  }
  return found;
}

describe('stream readers copy the bytes of every chunk', () => {
  it('recognises each unsafe form and allows the guarded view', () => {
    const reader = 'const { done, value } = await reader.read();\n';
    expect(unsafeChunkForms(`${reader}chunks.push(Buffer.from(value));`)).toHaveLength(1);
    expect(unsafeChunkForms(`${reader}chunks.push(new Uint8Array(value));`)).toHaveLength(1);
    expect(unsafeChunkForms(`${reader}buffer.set(value, total);`)).toHaveLength(1);
    expect(unsafeChunkForms(`${reader}chunks.push(value);`)).toHaveLength(1);
    expect(unsafeChunkForms(`${reader}const v = value instanceof ArrayBuffer\n  ? new Uint8Array(value)\n  : x;`)).toEqual([]);
    expect(unsafeChunkForms(`${reader}  // over an ArrayBuffer \`Buffer.from(value)\` is a view`)).toEqual([]);
    expect(unsafeChunkForms('chunks.push(Buffer.from(value));')).toEqual([]);
  });

  it('no stream reader in the tree keeps a chunk as a view or by reference', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const dir of SCANNED_DIRS) {
      for (const file of sourceFiles(path.join(ROOT, dir))) {
        const source = fs.readFileSync(file, 'utf8');
        if (/reader\.read\(\)/.test(source)) scanned += 1;
        for (const finding of unsafeChunkForms(source)) {
          offenders.push(`${path.relative(ROOT, file)}:${finding}`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
