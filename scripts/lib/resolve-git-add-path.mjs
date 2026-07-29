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
    return relPath;
  }
}

export function resolveGitAddPaths(repoRoot, relPaths) {
  return relPaths.map((p) => resolveGitAddPath(repoRoot, p));
}
