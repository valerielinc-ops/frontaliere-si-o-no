#!/usr/bin/env node
// scripts/extract-articles-package.mjs
//
// Issue #4881 Fase 6, Step 4 — separation.
//
// Extracts `packages/articles/` (this repo's article content + rendering
// engine workspace — see `packages/articles/index.ts` for its declared
// public API and `packages/articles/engine/siteShell.ts` for the
// SiteShellContract boundary) into a standalone directory that becomes the
// ROOT of a separate git repo: the `frontaliere-articles` package. Zero
// registry, zero hosting cost — once pushed, any project (including this
// one) consumes it via
//
//   npm install github:valerielinc-ops/frontaliere-articles#<sha>
//
// pinned to a commit sha (a branch or tag name also works), no npm
// registry publish involved.
//
// This script ONLY touches the local filesystem. It never runs `git remote
// add`, `git push`, `gh repo create`, or anything network-facing — creating
// and pushing the actual `valerielinc-ops/frontaliere-articles` GitHub repo
// is a deliberate, owner-only step (see "Owner command sequence" below),
// never something this script or an agent should do unattended.
//
// Usage:
//   node scripts/extract-articles-package.mjs --out <target-dir> [--init-git]
//
//   --out        target directory (created if absent; must be empty or
//                absent — refuses to overwrite an existing non-empty dir)
//   --init-git   additionally run `git init` + a single local commit in the
//                target dir, using whichever git identity is already
//                configured in the environment (this script never sets or
//                hardcodes an author identity). Still 100% local — no
//                remote is added or touched.
//
// Verifying fidelity: every file under the target dir must be byte-for-
// byte identical to its `packages/articles/` source, with nothing added,
// removed, or renamed — i.e. `diff -rq packages/articles <target-dir>`
// must produce empty output. tests/extract-articles-package.test.ts asserts
// exactly this on every run of this script into a fresh temp dir, so any
// future drift (a copy bug, an accidentally-skipped file type) is caught
// automatically rather than discovered at extraction time.
//
// Owner command sequence (manual — NOT run by this script or any agent):
//   node scripts/extract-articles-package.mjs --out /tmp/frontaliere-articles --init-git
//   cd /tmp/frontaliere-articles
//   gh repo create valerielinc-ops/frontaliere-articles --private --source=. --remote=origin
//   git push -u origin main
//   # then, in the main repo (or any consumer), pin to the pushed commit:
//   npm install github:valerielinc-ops/frontaliere-articles#<sha-from-the-push-above>

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
export const ARTICLES_PACKAGE_SOURCE_DIR = path.join(REPO_ROOT, 'packages', 'articles');

function parseArgs(argv) {
  const args = { out: null, initGit: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--init-git') args.initGit = true;
  }
  return args;
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      // packages/articles/ contains no symlinks today (confirmed by
      // tests/packages-articles-confinement.test.ts's file walk, which
      // would surface one via its own readdirSync). Refuse to silently
      // copy a dangling/ambiguous reference into the extracted repo if one
      // is ever added — fail loudly instead so it gets a deliberate fix.
      throw new Error(
        `extract-articles-package: unexpected symlink at ${path.relative(REPO_ROOT, s)} — ` +
          'this script does not know how to extract symlinks; resolve or remove it first.',
      );
    } else if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

/** Copies packages/articles/ -> outDir. Throws if outDir exists and is non-empty. */
export function extractArticlesPackage(outDir) {
  if (!outDir) throw new Error('extractArticlesPackage: outDir is required');
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`extractArticlesPackage: ${outDir} already exists and is not empty`);
  }
  copyDirRecursive(ARTICLES_PACKAGE_SOURCE_DIR, outDir);
  return outDir;
}

function main() {
  const { out, initGit } = parseArgs(process.argv.slice(2));
  if (!out) {
    console.error('Usage: node scripts/extract-articles-package.mjs --out <target-dir> [--init-git]');
    process.exit(1);
  }
  const outDir = path.resolve(out);
  extractArticlesPackage(outDir);
  console.log(`[extract-articles-package] copied packages/articles/ -> ${outDir}`);

  if (initGit) {
    execFileSync('git', ['init', '-q'], { cwd: outDir });
    execFileSync('git', ['add', '-A'], { cwd: outDir });
    execFileSync('git', ['commit', '-q', '-m', 'Extract from frontaliere-si-o-no packages/articles (issue #4881 Fase 6)'], {
      cwd: outDir,
    });
    console.log(
      `[extract-articles-package] initialized local git repo in ${outDir} (no remote configured — ` +
        'see this file\'s header comment for the owner-only push step)',
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
