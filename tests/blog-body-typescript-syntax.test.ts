import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import { ARTICLE_SECTION_CORE_LIST } from '../packages/articles/engine/shared/articleSectionCore.mjs';

// BOTH corpora. This guard covered only `blog-body` (frontaliere, ~12.1k
// files) and never `blog-body-ch` (svizzera, ~2.2k) — so an unescaped
// apostrophe written into a FR svizzera body on 2026-07-29 sailed past every
// check and killed all four build-locale jobs of every deploy until someone
// found it by reading build logs. A corpus the guard does not scan is a
// corpus where a syntax error is discovered in production.
const BLOG_BODY_ROOTS = ARTICLE_SECTION_CORE_LIST.map(({ section, kind, bodyDir }) => ({
  root: path.resolve(__dirname, '..', 'packages', 'articles', 'content', bodyDir),
  section,
  kind,
}));

function collectTypeScriptFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('blog body locale files', () => {
  // 10,000+ files. esbuild's async transform runs on its background service,
  // which parses concurrently across cores — ~2.3x faster here than the
  // single-threaded ts.transpileModule loop this replaced, for the same
  // syntax-only (no type-check) validation.
  it('parse as valid TypeScript modules', async () => {
    // PER-ROOT floor, deliberately not a total. blog-body alone yields ~12.1k
    // files, so a total-based threshold stays satisfied even if blog-body-ch
    // resolves to zero — an orphaned symlink or a renamed directory, exactly
    // the Fase 6 scenario this guard exists for — and would silence the very
    // gap being closed. Each corpus has to prove it was actually scanned.
    // Historical sections carry the established >1,000-file floor. Family
    // sections are enumerated too, but may legitimately have no body files
    // immediately after activation; their floor belongs to the section core's
    // registry policy, not this syntax-only Vitest guard.
    for (const { root, section, kind } of BLOG_BODY_ROOTS) {
      if (kind === 'canton') continue;
      expect(
        collectTypeScriptFiles(root).length,
        `${section}: ${path.relative(process.cwd(), root)} resolved to no files — the guard would scan nothing`,
      ).toBeGreaterThan(1_000);
    }
    const files = BLOG_BODY_ROOTS.flatMap(({ root }) => collectTypeScriptFiles(root));

    const results = await Promise.all(files.map(async (filePath) => {
      const source = fs.readFileSync(filePath, 'utf8');
      try {
        await esbuild.transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
        return null;
      } catch (err) {
        const messages = (err as { errors?: Array<{ text: string }> }).errors
          ?.map((e) => e.text)
          .join('\n') || String(err);
        return `${path.relative(process.cwd(), filePath)}\n${messages}`;
      }
    }));
    const failures = results.filter((f): f is string => f !== null);

    expect(
      failures,
      `Invalid blog body TypeScript files:\n\n${failures.slice(0, 10).join('\n\n')}`,
    ).toHaveLength(0);
  }, 60_000);
});
