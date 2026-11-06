import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../../scripts/lib/atomic-write-json.mjs';

// Regression guard for issue #2805 (follow-up to #2803): the ~95 crawler /
// job-data scripts now route every data/jobs.json write through this single
// atomic helper. A SIGKILL/OOM mid-write must never leave the served dataset
// truncated.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeJsonAtomic', () => {
  it('writes pretty-printed JSON with a trailing newline', () => {
    const p = path.join(dir, 'out.json');
    writeJsonAtomic(p, { a: 1, b: [2, 3] });
    const raw = fs.readFileSync(p, 'utf8');
    expect(raw).toBe(`${JSON.stringify({ a: 1, b: [2, 3] }, null, 2)}\n`);
    expect(JSON.parse(raw)).toEqual({ a: 1, b: [2, 3] });
  });

  it('writes minified JSON when { compact: true }', () => {
    const p = path.join(dir, 'compact.json');
    writeJsonAtomic(p, { a: 1, b: [2, 3] }, { compact: true });
    expect(fs.readFileSync(p, 'utf8')).toBe('{"a":1,"b":[2,3]}\n');
  });

  it('creates missing parent directories', () => {
    const p = path.join(dir, 'nested', 'deep', 'out.json');
    writeJsonAtomic(p, { ok: true });
    expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual({ ok: true });
  });

  it('leaves no temp file behind on success', () => {
    const p = path.join(dir, 'out.json');
    writeJsonAtomic(p, { ok: true });
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('does not clobber the existing file when serialization throws', () => {
    const p = path.join(dir, 'out.json');
    writeJsonAtomic(p, { good: 1 });
    const circular: Record<string, unknown> = {};
    circular.self = circular; // JSON.stringify throws → no rename happens
    expect(() => writeJsonAtomic(p, circular)).toThrow();
    // Original content survives intact (atomicity: no partial overwrite).
    expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual({ good: 1 });
    // And the failed write left no temp file behind.
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});
