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
