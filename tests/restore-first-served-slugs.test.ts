import fs from 'node:fs';
import { createHash } from 'node:crypto';
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

  function writePair(root: string, { count, impressions = 5, entries = 1 }: { count: number; impressions?: number; entries?: number }) {
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const url = 'https://frontaliereticino.ch/cerca-lavoro-ticino/slot-uno-azienda-lugano';
    const receipt = JSON.stringify({
      schema: 1,
      provider: 'google-search-console',
      property: 'https://frontaliereticino.ch/',
      exportedAt: '2026-11-28T00:00:00.000Z',
      selection: { count },
      rows: [{ url, impressions }],
    });
    fs.writeFileSync(path.join(dataDir, 'gsc-first-served-slug-receipt.json'), receipt);
    const entry = { slice: 'a.json', jobId: 'a-1', locale: 'it', previousSlug: 'slot-due', nextSlug: 'slot-uno-azienda-lugano', url };
    fs.writeFileSync(path.join(dataDir, 'gsc-first-served-slug-allowlist.json'), JSON.stringify({
      schema: 1,
      receiptSha256: createHash('sha256').update(receipt).digest('hex'),
      entries: Array.from({ length: entries }, (_, i) => ({ ...entry, jobId: `a-${i + 1}` })),
    }));
  }

  it('takes the approved slot count from the receipt, not from a constant', () => {
    const root = tempRoot();
    writePair(root, { count: 2, entries: 2 });

    const slots = readCanonicalGscAllowlist(root);

    expect(slots.size).toBe(2);
  });

  it('rejects an allowlist whose size differs from the count the receipt proves', () => {
    const root = tempRoot();
    writePair(root, { count: 2, entries: 1 });

    expect(() => readCanonicalGscAllowlist(root)).toThrow(/exactly the 2 entries proven by the receipt/);
  });

  it('rejects a receipt without a positive selection count', () => {
    const root = tempRoot();
    writePair(root, { count: 0 });

    expect(() => readCanonicalGscAllowlist(root)).toThrow(/identify the canonical property/);
  });

  it('rejects an entry whose URL has no positive impressions in the receipt', () => {
    const root = tempRoot();
    writePair(root, { count: 1, impressions: 0 });

    expect(() => readCanonicalGscAllowlist(root)).toThrow(/no positive-impression row/);
  });
});
