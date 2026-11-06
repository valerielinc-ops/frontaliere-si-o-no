#!/usr/bin/env node
/**
 * check-seo-pages-syntax — pre-commit parse gate for the machine-written
 * TypeScript this repo pushes straight to `main`:
 *   - services/seo/seo-pages.ts (and services/seoService.ts, which re-exports
 *     from it),
 *   - the article corpus under packages/articles/content/ (bodies + meta),
 *   - the translation chunks under services/locales/.
 *
 * Why this exists (issue #2834, hotfixed by PR #2833)
 * -----------------------------------------------------
 * An automated article-commit workflow (generate-article.yml /
 * publish-journalist-articles.yml) can push straight to `main` without ever
 * running the vitest gate. On 2026-06-24 an in-place edit left two
 * duplicate ListItem entries in seo-pages.ts's breadcrumb ItemList without a
 * trailing comma (`} {`) — a hard esbuild parse error
 * ("Expected \"]\" but found \"{\""). Because the commit was pushed
 * directly (bot-direct-to-main, same class documented in AGENTS.md "Data-
 * refresh che committa su main = stesso gate test"), nothing caught it
 * before it reached `main`: the vitest gate went RED and every branch
 * inherited it until the manual hotfix.
 *
 * `scripts/lib/resolve-append-conflicts.sh` already runs an esbuild parse
 * check, but ONLY on the git-rebase-conflict path (it's a function invoked
 * inside conflict resolution). The far more common CLEAN commit path (no
 * conflict — the exact scenario that broke main) never ran any syntax
 * check at all. This script closes that gap: run it unconditionally, right
 * before the commit step, in every workflow that writes to seo-pages.ts.
 *
 * Why the article corpus is checked too (2026-07-29)
 * --------------------------------------------------
 * Article bodies are emitted as single-quoted TS string literals, so one raw
 * apostrophe terminates the literal and breaks the module exactly the same
 * way. `blog-body-ch/fr/frontaliere-insegnante-scuola-ticino-stipendio-
 * requisiti.ts` shipped "l'expérience" unescaped and took the deploy build
 * down 52 minutes in ("Expected \"}\" but found \"expérience\""), failing the
 * fr, en and de locale jobs at once — the whole corpus compiles into every
 * locale bundle. Same class, one directory over. The PR path is gated by
 * tests/generated-content-parses.test.ts; this script covers the workflows that
 * commit article files without running vitest.
 *
 * The corpus is scanned whole, not just the files the current run touched:
 * checking only changed files would have waved this very incident through,
 * since the broken body arrived from an earlier commit and every later run
 * would see it as unchanged. ~14k modules parse in ~12s in-process — nothing
 * next to the 52-minute build they protect.
 *
 * Usage: node scripts/ci/check-seo-pages-syntax.mjs
 * Exit 0 = everything parses cleanly. Exit 1 = parse error — caller MUST
 * abort the commit/push.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { transformSync } from 'esbuild';

const SEO_FILES = ['services/seo/seo-pages.ts', 'services/seoService.ts'];
/**
 * Machine-written `Record<string, string>` modules, all single-quoted and all
 * therefore one raw apostrophe away from being unparseable. services/locales
 * holds symlinks to the two article body dirs; collectTsFiles() does not
 * follow symlinked directories, so they are scanned once, under their real
 * path.
 */
const GENERATED_TS_DIRS = ['packages/articles/content', 'services/locales'];

/** Every .ts file under dir, recursively. */
function collectTsFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** @returns {string|null} esbuild's error text, or null when the file parses. */
function parseError(file) {
  try {
    transformSync(readFileSync(file, 'utf-8'), { loader: 'ts', sourcefile: file });
    return null;
  } catch (err) {
    const first = err.errors?.[0];
    const where = first?.location ? `:${first.location.line}:${first.location.column}` : '';
    return `${file}${where}: ${first?.text ?? err.message ?? 'parse error'}`;
  }
}

let failed = false;

for (const file of SEO_FILES) {
  if (!existsSync(file)) {
    console.error(`⚠️  ${file}: not found, skipping`);
    continue;
  }
  const error = parseError(file);
  if (error) {
    failed = true;
    console.error(`❌ ${file}: esbuild parse/transform FAILED`);
    console.error(error);
  } else {
    console.error(`✅ ${file}: parses cleanly`);
  }
}

for (const dir of GENERATED_TS_DIRS) {
  const files = collectTsFiles(dir);
  if (!files.length) {
    console.error(`⚠️  ${dir}: not found, skipping`);
    continue;
  }
  const broken = files.map(parseError).filter(Boolean);
  if (broken.length) {
    failed = true;
    console.error(`❌ ${dir}: ${broken.length}/${files.length} module(s) FAILED to parse`);
    for (const error of broken) console.error(error);
    console.error(
      'An unescaped apostrophe inside a single-quoted string is the usual cause — escape it as \\\' .',
    );
  } else {
    console.error(`✅ ${dir}: ${files.length} module(s) parse cleanly`);
  }
}

if (failed) {
  console.error(
    '\n❌ check-seo-pages-syntax: aborting — unparseable machine-written TypeScript must never reach main (issue #2834).',
  );
  process.exit(1);
}

console.error('✅ check-seo-pages-syntax: all clear');
