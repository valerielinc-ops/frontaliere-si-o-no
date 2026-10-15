/**
 * git-grep.mjs — shared exit-code classifier for the zero-Claude `git grep` CI
 * gates (`check-cls-ad-slots.mjs`, `check-client-lookbehind.mjs`).
 *
 * Why this lives in one module (#2010): both gates spawn `git grep` via
 * `execFileSync`, which THROWS on any non-zero exit. `git grep` exits 1 when the
 * pattern simply has no match — a CLEAN result, not an error — so each gate must
 * swallow that one case and re-throw everything else. The classification logic was
 * copy-pasted verbatim in both files; a copy that drifts (e.g. one gate loosens to
 * `status >= 1`) would silently turn a real failure into a false-clean GREEN on a
 * funnel-critical invariant (hard-coded AdSense `<ins>` → CLS, or a client regex
 * lookbehind → Safari crash). Keeping the single source of truth here makes that
 * drift impossible by construction (AGENTS.md non-negotiable #6/#12).
 *
 * The ONLY error that counts as a legitimate no-match is: exit code exactly 1,
 * with NO stderr and NO stdout. Anything else — exit ≥2, exit 128 (bad pathspec /
 * not a repo / git missing), any stderr, or the anomalous exit-1-with-stdout — is
 * a real failure that the caller MUST re-throw, so the CI job fails LOUDLY instead
 * of returning `[]` (a false-clean on a tree that was never actually inspected).
 */

/**
 * True iff `e` is an `execFileSync` failure that represents a legitimate
 * `git grep` no-match (→ the caller may treat the search as clean and return []).
 * Returns false for every other failure, signalling the caller to re-throw.
 * Pure → unit-testable without spawning git.
 *
 * @param {unknown} e error thrown by `execFileSync('git', ['grep', ...])`
 * @returns {boolean}
 */
export function isGitGrepNoMatch(e) {
  if (!e || typeof e !== 'object') return false;
  const status = /** @type {{ status?: number }} */ (e).status;
  const stderr = /** @type {{ stderr?: { toString(): string } }} */ (e).stderr?.toString().trim();
  const stdout = /** @type {{ stdout?: { toString(): string } }} */ (e).stdout?.toString().trim();
  return status === 1 && !stderr && !stdout;
}
