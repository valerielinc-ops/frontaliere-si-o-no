// Where Codex agents create site worktrees outside the canonical isolation
// folders (`.claude/worktrees`, `.worktrees`, ...). Shared by the pruner
// sweep and the low-disk reclaimer, so the two scopes cannot drift apart.
//
// Measured on 2026-11-24: 18 worktrees in `~/.codex-worktrees` idle since 16/11
// on the agent host, and 30 `frontaliere-si-o-no-worktree-*` since 29/10 on the
// main laptop (in the workspace folder next to the site checkout, and one level
// above it), four of them 5.5 GiB full checkouts. Neither location was ever
// pruned.
//
// Deliberately narrow:
//   - `.codex-worktrees` only under the home directory, checked on both the
//     reported and the real path (a symlinked folder stays in scope);
//   - `<checkout>-worktree-<name>` only in the folder that holds the main
//     checkout or the one above it: a hand-made worktree elsewhere (Desktop,
//     an external disk) never falls under the removal rules by name alone;
//   - never the main checkout itself.
// `CODEX_HOME/worktrees` (lifecycle of the Codex app) is excluded by the
// callers, as before.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

function realPath(pathname) {
  try {
    return realpathSync(pathname);
  } catch {
    return resolve(pathname);
  }
}

function isStrictlyWithin(root, pathname) {
  const rel = relative(root, pathname);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function isCodexAgentWorktreePath(pathname, mainWorktreeRoot, { home = homedir() } = {}) {
  if (!pathname || !mainWorktreeRoot) return false;
  const reported = resolve(pathname);
  const real = realPath(pathname);
  const mainReported = resolve(mainWorktreeRoot);
  const mainReal = realPath(mainWorktreeRoot);
  if (reported === mainReported || real === mainReal) return false;

  const codexRoots = [resolve(home, '.codex-worktrees'), realPath(resolve(home, '.codex-worktrees'))];
  if (codexRoots.some((root) => isStrictlyWithin(root, reported) || isStrictlyWithin(root, real))) return true;

  const prefix = `${basename(mainReal)}-worktree-`;
  const siblingParents = new Set([
    dirname(mainReported), dirname(dirname(mainReported)),
    dirname(mainReal), dirname(dirname(mainReal)),
  ]);
  return [reported, real].some((candidate) => {
    const name = basename(candidate);
    return name.startsWith(prefix) && name !== prefix && siblingParents.has(dirname(candidate));
  });
}
