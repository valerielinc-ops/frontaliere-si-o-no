// Deterministic byte-equivalence gate for the fast-publish renderer (#4837).
//
// The risk this pins down: `renderArticlePages({ onlyArticleId })` narrows two
// things relative to a full-section render — the per-article BODY file read
// (single `<id>.ts` instead of a readdirSync over the whole locale dir) and the
// final write loop. If either narrowing changed a single byte of the emitted
// HTML, every fast-published article would silently differ from what the full
// `deploy.yml` build later overwrites it with, and the difference would only
// ever surface as churn in production.
//
// Why this test and not scripts/check-article-byte-identity.mjs: that script
// diffs against LIVE production HTML, which is genuinely useful as a manual
// end-to-end check but cannot gate CI — live HTML is always rendered from an
// older corpus (so related-articles picks legitimately differ) and Cloudflare
// injects its bot-fight script at the edge. This test compares two renders from
// the SAME working tree at the SAME commit, so any difference is a real defect.
//
// Uses the svizzera section: same code path as frontaliere, ~543 articles
// instead of ~3957, so a full-section render stays cheap enough to gate on.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { renderArticlePages } from '../build-plugins/ogPagesPlugin';

const rootDir = process.cwd();

function readIfPresent(base: string, rel: string): string | null {
  const abs = path.join(base, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
}

describe('renderArticlePages — single-article render equals full-section render', () => {
  it('emits byte-identical HTML for the same article in both modes', async () => {
    const fullDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogpages-full-'));
    const oneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogpages-one-'));

    try {
      const full = await renderArticlePages({ rootDir, distDir: fullDir, section: 'svizzera' });
      expect(full.entries.length).toBeGreaterThan(0);

      // Pick the most recently dated article: it is the one whose related-articles
      // block and prev/next neighbours are most sensitive to corpus ordering, i.e.
      // the case most likely to expose a narrowing bug.
      const target = full.entries[full.entries.length - 1];

      const one = await renderArticlePages({
        rootDir,
        distDir: oneDir,
        section: 'svizzera',
        onlyArticleId: target.articleId,
      });

      expect(one.entries).toHaveLength(1);
      expect(one.entries[0].articleId).toBe(target.articleId);

      // Same resolved hero image, same canonical URLs, same emitted paths.
      expect(one.entries[0].img).toBe(target.img);
      expect(one.entries[0].urls).toEqual(target.urls);
      expect(one.entries[0].paths).toEqual(target.paths);
      expect(one.entries[0].flatPaths).toEqual(target.flatPaths);

      // And, the part that actually matters: identical bytes on disk, for every
      // locale, for both the directory index.html and the flat redirect bridge.
      const rels = [...Object.values(target.paths), ...Object.values(target.flatPaths)];
      expect(rels.length).toBeGreaterThanOrEqual(8); // 4 locales x 2 file forms

      for (const rel of rels) {
        const fromFull = readIfPresent(fullDir, rel);
        const fromOne = readIfPresent(oneDir, rel);
        expect(fromFull, `full-section render missing ${rel}`).not.toBeNull();
        expect(fromOne, `single-article render missing ${rel}`).not.toBeNull();
        // Compare with an explicit message so a failure names the diverging file.
        expect(fromOne === fromFull, `byte mismatch in ${rel}`).toBe(true);
      }
    } finally {
      fs.rmSync(fullDir, { recursive: true, force: true });
      fs.rmSync(oneDir, { recursive: true, force: true });
    }
  }, 300_000);
});

// Byte-equivalence gate for the batched narrowing added in #4881 Fase 4
// (`onlyArticleIds`), which the corpus re-render driver uses to chunk a whole
// section into memory-bounded batches. Same risk as the `onlyArticleId`
// gate above, generalized to a Set: the body-file read and the write loop
// both switch from a single id to `onlyArticleIdSet.has(...)`, and a batch of
// several ids exercises the Set-iteration path that a lone id cannot.
describe('renderArticlePages — batched onlyArticleIds render equals full-section render', () => {
  it('emits byte-identical HTML, for every requested id, matching the full-section render', async () => {
    const fullDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogpages-full-batch-'));
    const batchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogpages-batch-'));

    try {
      const full = await renderArticlePages({ rootDir, distDir: fullDir, section: 'svizzera' });
      expect(full.entries.length).toBeGreaterThan(5);

      // Oldest, newest and one from the middle: spans the entriesByDate
      // ordering most likely to expose a batching-specific regression.
      const targets = [
        full.entries[0],
        full.entries[Math.floor(full.entries.length / 2)],
        full.entries[full.entries.length - 1],
      ];
      const targetIds = targets.map((t) => t.articleId);

      // Superset-safe: a phantom id belonging to no article in this section
      // must be a silent no-op, never an error and never a phantom entry.
      const idsWithPhantom = [...targetIds, '__nonexistent-article-id-4881__'];

      const batch = await renderArticlePages({
        rootDir,
        distDir: batchDir,
        section: 'svizzera',
        onlyArticleIds: idsWithPhantom,
      });

      expect(batch.entries).toHaveLength(targetIds.length);
      expect(new Set(batch.entries.map((e) => e.articleId))).toEqual(new Set(targetIds));

      for (const target of targets) {
        const fromBatch = batch.entries.find((e) => e.articleId === target.articleId)!;
        expect(fromBatch.img).toBe(target.img);
        expect(fromBatch.urls).toEqual(target.urls);
        expect(fromBatch.paths).toEqual(target.paths);
        expect(fromBatch.flatPaths).toEqual(target.flatPaths);

        const rels = [...Object.values(target.paths), ...Object.values(target.flatPaths)];
        expect(rels.length).toBeGreaterThanOrEqual(8); // 4 locales x 2 file forms

        for (const rel of rels) {
          const fromFull = readIfPresent(fullDir, rel);
          const fromBatchDisk = readIfPresent(batchDir, rel);
          expect(fromFull, `full-section render missing ${rel}`).not.toBeNull();
          expect(fromBatchDisk, `batch render missing ${rel}`).not.toBeNull();
          expect(fromBatchDisk === fromFull, `byte mismatch in ${rel}`).toBe(true);
        }
      }
    } finally {
      fs.rmSync(fullDir, { recursive: true, force: true });
      fs.rmSync(batchDir, { recursive: true, force: true });
    }
  }, 300_000);
});

// Regression gate for the byline date bug fixed in #4837.
//
// normalizeDateTime stamps bare dates as `T00:00:00+01:00` (Swiss wall clock),
// and the `datetime` attribute publishes that literal date. The visible text
// used to be derived via `new Date(iso).getDate()`, i.e. the RUNNING PROCESS's
// zone — and CI builds in UTC, where that instant is 23:00 the previous day.
// Production before the fix, on /articoli-frontaliere/confronto-assicurazioni-auto/:
//   <time datetime="2026-02-26" itemprop="datePublished">25 febbraio 2026</time>
// Google reads the attribute, the reader reads the text, and they disagreed by a
// day on ~142 articles. This asserts they agree, for an article that actually
// sits in the midnight-CET window where the bug bit.
describe('article byline date agrees with its own datetime attribute', () => {
  const MONTHS_IT = ['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'];

  it('renders the same calendar day in the attribute and in the visible text', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogpages-date-'));
    try {
      const res = await renderArticlePages({
        rootDir,
        distDir: outDir,
        section: 'svizzera',
        onlyArticleId: 'costo-vita-svizzera-2026', // datePublished sits in the T00:xx+01:00 window
      });
      expect(res.entries).toHaveLength(1);

      const html = fs.readFileSync(path.join(outDir, res.entries[0].paths.it), 'utf-8');
      const m = /<time datetime="([^"]+)"[^>]*itemprop="datePublished"[^>]*>([^<]+)<\/time>/.exec(html);
      expect(m, 'no datePublished <time> element found in the rendered article').not.toBeNull();

      const [, attr, visible] = m!;
      const [yearStr, monthStr, dayStr] = attr.split('T')[0].split('-');
      const expected = `${Number(dayStr)} ${MONTHS_IT[Number(monthStr) - 1]} ${Number(yearStr)}`;
      expect(visible.trim()).toBe(expected);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 120_000);
});
