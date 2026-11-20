import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCanonicalGscAllowlist } from '../scripts/restore-first-served-slugs.mjs';

const roots: string[] = [];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'first-served-gsc-gate-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('FU-005 canonical GSC apply gate', () => {
  it('requires the allowlist at its canonical versioned path', () => {
    const root = tempRoot();

    expect(() => readCanonicalGscAllowlist(root)).toThrow(/requires the versioned GSC allowlist/);
  });

  it('requires the matching receipt at its canonical versioned path', () => {
    const root = tempRoot();
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    // Minimal invalid allowlist sentinel only: it contains no GSC rows or URLs.
    fs.writeFileSync(path.join(dataDir, 'gsc-first-served-slug-allowlist.json'), JSON.stringify({
      schema: 1,
      receiptSha256: 'test-missing-canonical-receipt',
      entries: [],
    }), 'utf8');

    expect(() => readCanonicalGscAllowlist(root)).toThrow(/requires the versioned GSC receipt/);
  });
});
