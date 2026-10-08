import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'scripts/audit/sync-published-blog-covers.mjs');
const roots: string[] = [];

function fixture({ withImage = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-blog-covers-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'packages/articles/content'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'public/images/blog'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/articles/content/blog-articles-data.ts'), `export const ARTICLES = [
  {
    id: 'new-cover',
    category: 'news',
    date: '2026-10-07T10:00:00.000Z',
    updatedAt: null,
    image: '/images/blog/new-cover.webp',
    authorSlug: 'redazione',
  },
];\n`);
  fs.writeFileSync(path.join(root, 'packages/articles/content/swiss-articles-data.ts'), 'export const ARTICLES = [];\n');
  fs.writeFileSync(path.join(root, 'data/blog-cover-ledger.json'), `${JSON.stringify({
    schema: 1,
    generatedAt: '2026-10-06',
    counts: {},
    covers: {
      existing: { proofLevel: 6, evidence: 'inferred', published: true, action: 'record-inferred' },
    },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'data/image-credits-blog.json'), `${JSON.stringify({
    schema: 1,
    covers: { existing: { evidence: 'inferred', provider: null, verifiedAt: '2026-10-06', status: 'no-credit' } },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'data/blog-cover-corpus-baseline.json'), `${JSON.stringify({
    schema: 1,
    sourceCommit: 'b'.repeat(40),
    generatedAt: '2026-10-06',
    registries: {
      'packages/articles/content/blog-articles-data.ts': { corpusPath: 'content/blog-articles-data.ts', articles: 0, distinctImages: 0 },
      'packages/articles/content/swiss-articles-data.ts': { corpusPath: 'content/swiss-articles-data.ts', articles: 0, distinctImages: 0 },
    },
  }, null, 2)}\n`);
  if (withImage) fs.writeFileSync(path.join(root, 'public/images/blog/new-cover.webp'), 'cover-bytes');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('sync-published-blog-covers', () => {
  it('adds only missing published covers to the paired ledger and index, idempotently', () => {
    const root = fixture();
    execFileSync(process.execPath, [SCRIPT], { cwd: root, env: { ...process.env, ARTICLES_SYNC_COMMIT: 'a'.repeat(40) } });
    const ledgerPath = path.join(root, 'data/blog-cover-ledger.json');
    const indexPath = path.join(root, 'data/image-credits-blog.json');
    const firstLedger = fs.readFileSync(ledgerPath, 'utf8');
    const firstIndex = fs.readFileSync(indexPath, 'utf8');
    const ledger = JSON.parse(firstLedger);
    const index = JSON.parse(firstIndex);
    const baseline = JSON.parse(fs.readFileSync(path.join(root, 'data/blog-cover-corpus-baseline.json'), 'utf8'));

    expect(ledger.covers.existing).toEqual({ proofLevel: 6, evidence: 'inferred', published: true, action: 'record-inferred' });
    expect(ledger.covers['new-cover']).toMatchObject({
      cover: '/images/blog/new-cover.webp',
      published: true,
      proofLevel: 6,
      evidence: 'inferred',
      status: 'no-credit',
    });
    expect(ledger.covers['new-cover'].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(index.covers['new-cover']).toMatchObject({ evidence: 'inferred', provider: null, status: 'no-credit' });
    expect(baseline).toMatchObject({
      sourceCommit: 'a'.repeat(40),
      registries: {
        'packages/articles/content/blog-articles-data.ts': { articles: 1, distinctImages: 1 },
        'packages/articles/content/swiss-articles-data.ts': { articles: 0, distinctImages: 0 },
      },
    });

    const output = execFileSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
    expect(JSON.parse(output).added).toBe(0);
    expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(firstLedger);
    expect(fs.readFileSync(indexPath, 'utf8')).toBe(firstIndex);

    const withoutNewIndex = JSON.parse(firstIndex);
    delete withoutNewIndex.covers['new-cover'];
    fs.writeFileSync(indexPath, `${JSON.stringify(withoutNewIndex, null, 2)}\n`);
    const repairOutput = execFileSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
    expect(JSON.parse(repairOutput)).toMatchObject({ added: 0, repairedIndexKeys: ['new-cover'] });
    expect(JSON.parse(fs.readFileSync(indexPath, 'utf8')).covers['new-cover']).toMatchObject({
      evidence: 'inferred',
      status: 'no-credit',
    });
  });

  it('fails closed without changing either file when a published cover blob is unavailable', () => {
    const root = fixture({ withImage: false });
    const ledgerPath = path.join(root, 'data/blog-cover-ledger.json');
    const indexPath = path.join(root, 'data/image-credits-blog.json');
    const beforeLedger = fs.readFileSync(ledgerPath, 'utf8');
    const beforeIndex = fs.readFileSync(indexPath, 'utf8');
    const baselinePath = path.join(root, 'data/blog-cover-corpus-baseline.json');
    const beforeBaseline = fs.readFileSync(baselinePath, 'utf8');

    const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Published cover blob is unavailable');
    expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(beforeLedger);
    expect(fs.readFileSync(indexPath, 'utf8')).toBe(beforeIndex);
    expect(fs.readFileSync(baselinePath, 'utf8')).toBe(beforeBaseline);
  });
});
