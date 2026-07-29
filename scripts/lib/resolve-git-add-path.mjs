import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve a repo-relative path (file or directory, optional trailing slash)
 * through any symlinks before handing it to `git add`. Since the Fase 6
 * articles-package migration (packages/articles/, #4881/#4919),
 * services/locales/blog-body{,-ch} and services/locales/blog-meta-*.ts are
 * OS symlinks into packages/articles/content/. `git add` refuses a pathspec
 * that walks through a symlinked directory component ("fatal: pathspec ...
 * is beyond a symbolic link") and silently no-ops when the pathspec IS a
 * file symlink whose target changed — the symlink blob itself is unchanged,
 * so nothing gets staged and the real edit is lost. Falls back to the
 * original path when it doesn't exist yet or resolves to itself (no symlink
 * anywhere in the chain).
 */
export function resolveGitAddPath(repoRoot, relPath) {
  const trailingSlash = relPath.endsWith('/');
  const bare = trailingSlash ? relPath.slice(0, -1) : relPath;
  try {
    const real = realpathSync(path.join(repoRoot, bare));
    const relReal = path.relative(repoRoot, real);
    return trailingSlash ? `${relReal}/` : relReal;
  } catch {
    // The path itself no longer exists — the DELETED-file case, which is the
    // one that matters most here: `manage-article.mjs remove` unlinks per-locale
    // body files and then has to stage the deletion. realpathSync fails on the
    // missing leaf, but the symlinked DIRECTORY above it still resolves, so
    // resolve the parent and re-join the basename. Without this the function
    // returned the symlink-traversing path unchanged, `git ls-files` on it was
    // always empty (git only ever tracks the real path), and the deletion was
    // silently left unstaged — the exact gap the caller believes it closed.
    try {
      const dir = realpathSync(path.join(repoRoot, path.dirname(bare)));
      const relReal = path.join(path.relative(repoRoot, dir), path.basename(bare));
      return trailingSlash ? `${relReal}/` : relReal;
    } catch {
      return relPath;
    }
  }
}

export function resolveGitAddPaths(repoRoot, relPaths) {
  return relPaths.map((p) => resolveGitAddPath(repoRoot, p));
}
