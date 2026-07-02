#!/usr/bin/env node
/**
 * check-seo-pages-syntax — pre-commit parse gate for
 * services/seo/seo-pages.ts (and services/seoService.ts, which re-exports
 * from it).
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
 * Usage: node scripts/ci/check-seo-pages-syntax.mjs
 * Exit 0 = both files parse cleanly. Exit 1 = parse error — caller MUST
 * abort the commit/push.
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILES = ['services/seo/seo-pages.ts', 'services/seoService.ts'];

let failed = false;

for (const file of FILES) {
  if (!existsSync(file)) {
    console.error(`⚠️  ${file}: not found, skipping`);
    continue;
  }
  try {
    execFileSync(
      'npx',
      ['esbuild', file, '--loader:.ts=ts', '--log-level=warning', '--outfile=/dev/null'],
      { stdio: 'pipe' },
    );
    console.error(`✅ ${file}: parses cleanly`);
  } catch (err) {
    failed = true;
    console.error(`❌ ${file}: esbuild parse/transform FAILED`);
    const output = [err.stdout, err.stderr]
      .filter(Boolean)
      .map((b) => b.toString())
      .join('\n');
    console.error(output || err.message);
  }
}

if (failed) {
  console.error(
    '\n❌ check-seo-pages-syntax: aborting — a broken seo-pages.ts/seoService.ts must never reach main (issue #2834).',
  );
  process.exit(1);
}

console.error('✅ check-seo-pages-syntax: all clear');
