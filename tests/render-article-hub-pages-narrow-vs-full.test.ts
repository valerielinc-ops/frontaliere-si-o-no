// Byte-equivalence gate for the fast-publish hub renderer (issue #4881 Fase 1).
//
// The risk this pins down: `renderArticleHubPages` is a SECOND entry point
// into the article-hub rendering logic — it resolves its own fs/path/SPA-
// bundle info and writes through its own `WriteCollector` instead of the
// `qw`/`entryJs`/`entryCss` a full `vite build` hands `emitSeoHubs`. Both
// ultimately delegate to the same synchronous `renderArticleHubPagesCore`,
// but the wrapper's own plumbing (SPA-bundle resolution, path joining,
// locale defaulting) could still silently diverge from what the full build
// emits. If it did, every fast-published article's `/tutti/` archive +
// pagination would differ from what the next full `deploy.yml` build later
// overwrites it with — churn that would only ever surface in production.
//
// Uses BOTH article sections (frontaliere and svizzera) since #4881
// consolidated their formerly-separate emitters into one shared core — a
// regression could plausibly hit just one section.
//
// Same rationale as tests/render-article-pages-single-vs-full.test.ts: this
// compares two renders from the SAME working tree at the SAME commit, so any
// difference is a real defect, not corpus drift or edge-injected content.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { emitSeoHubs, renderArticleHubPages } from '../build-plugins/seoHubsPlugin';
import { resolveSpaBundle } from '../build-plugins/spaBundleResolver';
import type { ArticleSection } from '../services/articleSections';

const rootDir = process.cwd();

function readIfPresent(base: string, rel: string): string | null {
  const abs = path.join(base, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
}

// The full-build side writes eagerly and synchronously (no batching/skip
// logic) so every page lands on disk unconditionally — the narrow side still
// goes through the real `WriteCollector`, so any divergence there also gets
// exercised, not bypassed.
function writeSync(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

describe('renderArticleHubPages — narrow fast-publish render equals full emitSeoHubs render', () => {
  let fullDir: string;

  beforeAll(() => {
    fullDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seohubs-full-'));
    const { entryJs, entryCss, hasSpaBundle } = resolveSpaBundle(fullDir);

    // Full build path: the real emitSeoHubs, exercising every hub kind
    // (jobs/sectors/companies + both article sections) exactly like a
    // production `vite build` closeBundle() hook would.
    emitSeoHubs({
      rootDir,
      distDir: fullDir,
      fs,
      np: path,
      entryJs,
      entryCss,
      hasSpaBundle,
      qw: writeSync,
    });
    // seoHubsPlugin-hub-locale-reciprocity.test.ts measured full-suite runs at
    // ~360s wall on a loaded CI shard; mirror its raised hook budget so real
    // work under load isn't misread as a failure.
  }, 60_000);

  afterAll(() => {
    fs.rmSync(fullDir, { recursive: true, force: true });
  });

  it.each(['frontaliere', 'svizzera'] as const)(
    'emits byte-identical %s hub HTML to the full-build emitter',
    async (section: ArticleSection) => {
      const narrowDir = fs.mkdtempSync(path.join(os.tmpdir(), `seohubs-narrow-${section}-`));
      try {
        const narrow = await renderArticleHubPages({ rootDir, distDir: narrowDir, section });
        const allPaths = Object.values(narrow.pathsByLocale).flat();

        // Sanity: a real render, not a silent no-op. Each section emits at
        // least a page-1 per locale (4), even against an empty registry (the
        // core's documented empty-state behaviour — it EMITS-EMPTY, never
        // skips).
        expect(allPaths.length).toBeGreaterThanOrEqual(4);
        expect(narrow.written).toBe(allPaths.length);
        // Every emitted path is grouped under the locale its own directory
        // prefix implies (it: no prefix, en/de/fr: `<loc>/...`) — proves
        // onPageEmitted's locale argument tracks the loop it fires inside.
        for (const [locale, rels] of Object.entries(narrow.pathsByLocale)) {
          for (const rel of rels) {
            const expectedPrefix = locale === 'it' ? '' : `${locale}/`;
            if (expectedPrefix) expect(rel.startsWith(expectedPrefix), rel).toBe(true);
          }
        }

        for (const rel of allPaths) {
          const fromFull = readIfPresent(fullDir, rel);
          const fromNarrow = readIfPresent(narrowDir, rel);
          expect(fromFull, `full-build render missing ${rel}`).not.toBeNull();
          expect(fromNarrow, `narrow render missing ${rel}`).not.toBeNull();
          expect(fromNarrow === fromFull, `byte mismatch in ${rel}`).toBe(true);
        }
      } finally {
        fs.rmSync(narrowDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
