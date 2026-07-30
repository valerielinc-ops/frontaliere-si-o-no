#!/usr/bin/env node
/**
 * `git add`, but with every pathspec resolved through symlinks first.
 *
 * Workflows that stage corpus files by literal path hit two different failure
 * modes since the articles package moved the real files under
 * `packages/articles/content/` (#4881 Fase 6, and #4974 for `seo-blog*.ts`),
 * leaving symlinks at the historical paths:
 *
 *   - a path THROUGH a symlinked directory (`services/locales/blog-body/it/x.ts`)
 *     makes git abort with `fatal: pathspec ... is beyond a symbolic link`,
 *     which under `set -e` takes the whole commit down — including the
 *     unrelated files staged in the same command;
 *   - a path that IS a file symlink (`services/seo/seo-blog-5.ts`) succeeds and
 *     stages NOTHING, because the symlink's own blob — the target string — did
 *     not change. The edit written through it lives at the real path, which was
 *     never in the pathspec. No error, no warning, exit 0, change silently lost.
 *
 * The second one is the dangerous one: `crawl-events.yml` bumps `dateModified`
 * on the weekend-digest article every week, and would have gone on reporting
 * success while the freshness signal stayed frozen.
 *
 * `scripts/lib/resolve-git-add-path.mjs` already solves this for the Node
 * callers (`create-article.mjs`, `manage-article.mjs`). This is the same
 * resolver, exposed to the shell, so a workflow does not have to hardcode
 * `packages/articles/content/...` — hardcoding just moves the breakage to the
 * next time the corpus is relocated, and there is no test that would catch it.
 *
 * `--print-only` resolves and prints the paths, one per line, without staging
 * anything. `git diff -- <symlinked path>` is silent in the same way `git add`
 * is — it reports no changes at all for edits made through the symlink — so a
 * workflow gating a commit on `git diff --name-only -- services/locales/blog-body/`
 * sees zero every time and never commits. Those callers need the resolved path
 * too, and must not get it by hardcoding `packages/articles/content/...`.
 *
 * Usage:
 *   node scripts/lib/git-add-resolved.mjs <path> [<path>...]
 *   node scripts/lib/git-add-resolved.mjs --print-only <path> [<path>...]
 *
 * Missing paths are passed through unchanged, so git's own "pathspec did not
 * match" error still surfaces rather than being swallowed here.
 */
import { execFileSync } from 'node:child_process';
import { resolveGitAddPaths } from './resolve-git-add-path.mjs';

const argv = process.argv.slice(2);
const printOnly = argv[0] === '--print-only';
const paths = printOnly ? argv.slice(1) : argv;
if (paths.length === 0) {
  console.error('usage: git-add-resolved.mjs [--print-only] <path> [<path>...]');
  process.exit(2);
}

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
const resolved = resolveGitAddPaths(repoRoot, paths);

if (printOnly) {
  console.log(resolved.join('\n'));
  process.exit(0);
}

for (const [i, p] of paths.entries()) {
  if (p !== resolved[i]) console.log(`[git-add-resolved] ${p} → ${resolved[i]}`);
}

execFileSync('git', ['add', '--', ...resolved], { cwd: repoRoot, stdio: 'inherit' });
