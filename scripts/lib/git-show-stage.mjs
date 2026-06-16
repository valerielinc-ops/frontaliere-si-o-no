#!/usr/bin/env node
/**
 * Shared reader for a conflicted file's index stage during `git rebase`.
 *
 * The in-place rebase resolvers (winners / fb-posted / reddit-posted /
 * 404-compat registries) all read a conflict stage via
 * `git show :<stage>:<path>`. Those registries are append-only accumulators
 * kept unpruned in-repo, so they grow unbounded over time.
 *
 * `execFileSync`'s DEFAULT maxBuffer is 1 MiB. Once a registry crosses 1 MiB,
 * the child's stdout overflows and the call throws `spawnSync git ENOBUFS`,
 * failing the post-deploy publish rebase — exactly what killed run
 * 27592889914 (data/previous-slug-winners.json had grown past 1 MiB). Setting
 * a generous ceiling makes that whole class impossible by construction: the
 * buffer only grows to the actual output size, the cap is just the limit.
 */
import { execFileSync } from 'node:child_process';

// 256 MiB — orders of magnitude above any realistic registry size, while still
// bounded. This is a ceiling, not a pre-allocation.
export const GIT_SHOW_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * `git show :<stage>:<target>` for the indexed (conflict-stage) version of a
 * path, with a maxBuffer large enough for unbounded-growth registries.
 *
 * @param {number} stage - index stage (1 = base, 2 = ours/upstream, 3 = theirs/local)
 * @param {string} target - repo-relative path
 * @returns {string} file contents (utf-8)
 */
export function gitShowStage(stage, target) {
  return execFileSync('git', ['show', `:${stage}:${target}`], {
    encoding: 'utf-8',
    maxBuffer: GIT_SHOW_MAX_BUFFER,
  });
}
