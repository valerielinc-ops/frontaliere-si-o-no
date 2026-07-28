/**
 * Shared helpers behind the post-build audit speedups (run 30376520728, where
 * audit:hreflang at 2000 s and audit:canonical-trailing-slash at 1711 s were
 * the critical path of a 58m55s job).
 *
 * `readHeadOrAll` lets a gate that only inspects <head> metadata stop reading
 * there instead of pulling whole pages off disk. `resolveSamplingEnv` parses
 * the AUDIT_SAMPLE_* pair that post-deploy-validate-dist.yml sets once for the
 * whole step, so every opted-in gate reads it identically.
 *
 * The property that matters for AGENTS.md non-negotiable #1: neither helper may
 * ever quietly narrow a gate. A malformed sample rate must degrade to "scan
 * everything", and a head larger than the read window must fall back to the
 * whole file rather than silently returning a truncated document.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readHeadOrAll, readHeadOrAllSync, HEAD_CHUNK_BYTES } from '../../scripts/lib/readHead.mjs';
import { resolveSamplingEnv, sampleFiles } from '../../scripts/lib/audit-runner.mjs';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readhead-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, 'utf-8');
  return p;
}

describe('readHeadOrAll', () => {
  it('returns the whole document when it is smaller than the read window', async () => {
    const html = '<html><head><link rel="canonical" href="https://x/"></head><body>hi</body></html>';
    expect(await readHeadOrAll(write('small.html', html))).toBe(html);
  });

  it('stops at </head> for a document larger than the read window', async () => {
    const html =
      `<html><head><link rel="canonical" href="https://x/"></head><body>${'z'.repeat(HEAD_CHUNK_BYTES * 2)}</body></html>`;
    const out = await readHeadOrAll(write('big-body.html', html));
    expect(out).toContain('rel="canonical"');
    expect(out).not.toContain('zzz');
    expect(out!.length).toBeLessThan(HEAD_CHUNK_BYTES);
  });

  it('falls back to the whole file when the head itself exceeds the window', async () => {
    const html =
      `<html><head><meta name="pad" content="${'y'.repeat(HEAD_CHUNK_BYTES + 1000)}">` +
      `<link rel="canonical" href="https://late/"></head><body>b</body></html>`;
    const out = await readHeadOrAll(write('big-head.html', html));
    // The canonical sits past the window — a truncating read would lose it.
    expect(out).toContain('https://late/');
  });

  it('returns null for an unreadable path instead of throwing', async () => {
    expect(await readHeadOrAll(path.join(dir, 'does-not-exist.html'))).toBeNull();
  });
});

describe('readHeadOrAllSync', () => {
  it('agrees with the async twin on every case', async () => {
    const cases = {
      'small.html': '<html><head><link rel="canonical" href="https://x/"></head><body>hi</body></html>',
      'big-body.html':
        `<html><head><link rel="canonical" href="https://x/"></head><body>${'z'.repeat(HEAD_CHUNK_BYTES * 2)}</body></html>`,
      'big-head.html':
        `<html><head><meta name="pad" content="${'y'.repeat(HEAD_CHUNK_BYTES + 1000)}">` +
        `<link rel="canonical" href="https://late/"></head><body>b</body></html>`,
    };
    for (const [name, body] of Object.entries(cases)) {
      const p = write(name, body);
      expect(readHeadOrAllSync(p), name).toBe(await readHeadOrAll(p));
    }
  });

  it('throws like readFileSync on a missing path, so caller try/catch still fires', () => {
    expect(() => readHeadOrAllSync(path.join(dir, 'nope.html'))).toThrow();
  });
});

describe('resolveSamplingEnv', () => {
  it('defaults to no sampling when the vars are absent', () => {
    expect(resolveSamplingEnv({})).toEqual({ rate: 1, salt: 0 });
  });

  it('parses a valid rate and salt', () => {
    expect(resolveSamplingEnv({ AUDIT_SAMPLE_RATE: '0.25', AUDIT_SAMPLE_SALT: '2930' }))
      .toEqual({ rate: 0.25, salt: 2930 });
  });

  it.each(['0', '-1', '1.5', 'abc', ''])(
    'degrades a malformed rate (%s) to a full scan, never a narrower one',
    (bad) => {
      expect(resolveSamplingEnv({ AUDIT_SAMPLE_RATE: bad }).rate).toBe(1);
    },
  );

  it('tolerates a non-numeric salt by falling back to bucket 0', () => {
    expect(resolveSamplingEnv({ AUDIT_SAMPLE_RATE: '0.5', AUDIT_SAMPLE_SALT: 'nope' }).salt).toBe(0);
  });
});

describe('sampleFiles rotation', () => {
  const files = Array.from({ length: 400 }, (_, i) => path.join('/dist', `p-${i}`, 'index.html'));

  it('covers every file exactly once across a full salt rotation', () => {
    const seen = new Set<string>();
    let sum = 0;
    for (let salt = 0; salt < 4; salt++) {
      const { sampled } = sampleFiles(files, '/dist', 0.25, salt);
      sum += sampled.length;
      for (const f of sampled) seen.add(f);
    }
    expect(seen.size).toBe(files.length);
    expect(sum).toBe(files.length); // buckets are disjoint — no double scanning
  });

  it('is stable: the same salt always selects the same bucket', () => {
    const a = sampleFiles(files, '/dist', 0.25, 7).sampled;
    const b = sampleFiles(files, '/dist', 0.25, 7).sampled;
    expect(a).toEqual(b);
  });

  it('is an identity at rate 1', () => {
    expect(sampleFiles(files, '/dist', 1, 3).sampled).toEqual(files);
  });
});
