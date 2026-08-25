/**
 * hook-target-cwd.mjs — the directory a PreToolUse `Bash` hook should
 * actually operate on, in one place.
 *
 * Claude Code's PreToolUse payload carries a top-level `cwd` field: the
 * session's tracked working directory, updated after every `cd` in a prior
 * Bash call (https://code.claude.com/docs/en/hooks — confirmed 2026-08-25).
 * What it does NOT mean is that the hook's own OS subprocess is spawned
 * there — Claude Code pins that independently (in this repo, both gates are
 * declared as `sh -c '... node "$d/scripts/ci/<gate>.mjs"'` with no `cd`), so
 * `process.cwd()` inside the hook reflects wherever the hook runner itself
 * launched from, not the worktree the gated command is about to run in.
 *
 * The two `gh pr create` PreToolUse gates in this repo used to read only
 * `tool_input.command` and let their child `git`/`readFileSync` calls
 * inherit the hook's own ambient cwd. Observed 2026-08-25: a PR opened from
 * a worktree got the wrong gate verdict, citing a file that was dirty only
 * in an unrelated main checkout the gated branch never touched at all. The
 * agent worked around it by calling the GitHub API directly instead of
 * `gh pr create`; this module is the actual fix, not the workaround.
 *
 * Fail-safe by construction: any missing/malformed/nonexistent `cwd` returns
 * `undefined`, which `execFileSync`'s own `cwd` option treats identically to
 * "not passed" — i.e. today's behaviour (inherit the ambient cwd), never a
 * new failure mode.
 */
import { statSync } from 'node:fs';

/**
 * @param {{ cwd?: unknown }} payload parsed PreToolUse stdin JSON
 * @returns {string|undefined} an existing directory, or `undefined`
 */
export function resolveHookTargetCwd(payload) {
  const candidate = payload?.cwd;
  if (typeof candidate !== 'string' || !candidate) return undefined;
  try {
    return statSync(candidate).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}
