/**
 * workflow-scope-detect.mjs — shared `.github/workflows/**`-scope detection.
 *
 * Extracted from followup-drainer.mjs (escalation #1724) so `check-workflows-scope.mjs`
 * (escalation #3887/#4227) shares the SAME regex + exclusion logic instead of a
 * hand-duplicated copy. The duplication was the direct cause of a false-positive
 * infinite loop (issue #4437, observed 2026-07-18→2026-07-27, 51 identical park
 * comments over 9 days): followup-drainer's `detectWorkflowScoped` correctly bails out
 * when the body ALSO cites non-workflow code paths (the fix might live there), but
 * check-workflows-scope.mjs's `extractWorkflowPaths` had no such exclusion — it blocked
 * on ANY `.github/workflows/*.yml` substring, even a passing reference inside an
 * unrelated "live-verification" checklist bullet. That asymmetry meant: the drainer
 * would happily re-promote the issue (its own check says "not scoped"), issue-fix.yml's
 * own pre-flight would immediately re-block it, and — because the block removed
 * `agent:fix` without adding any terminal label — issue-triage.yml's sweep would treat
 * it as unrouted and re-queue it, forever, ~4h cadence.
 *
 * CONSERVATIVE (bias to PROMOTE — a false park/block delays a real fix): a body is
 * "exclusively workflow-scoped" only when it cites ≥1 workflow path AND no non-workflow
 * code path (scripts/build-plugins/services/components/hooks/build/src/...). If it
 * cites both, the fix might live in the code file → let the fixer decide.
 */

// Matches `.github/workflows/<name>.yml` (or `.yaml`) ANYWHERE in body text — backticks,
// fenced code blocks, or bare markdown prose/bullets.
export const WORKFLOW_PATH_RE = /\.github\/workflows\/[A-Za-z0-9._/-]+\.ya?ml\b/g;

// Bare `<name>.yml` (a workflow is always .yml; in a follow-up a bare .yml that isn't a
// known config file indicates a workflow file almost every time).
export const BARE_YML_RE = /\b[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml\b/g;

// Non-workflow code paths: if cited, the fix might live there → not exclusively scoped.
export const CODE_PATH_RE = /\b(?:scripts|build-plugins|services|components|hooks|build|src)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+\b/g;

// `.yml` config files that are NOT workflows (don't imply the `workflows` scope).
export const NON_WORKFLOW_YML = new Set([
  'lighthouserc.yml', 'pnpm-workspace.yml', 'docker-compose.yml',
  '.prettierrc.yml', 'vitest.yml',
]);

/** True if `text` cites at least one non-workflow code path (scripts/, build-plugins/, ...). */
export function hasNonWorkflowCodeRefs(text) {
  return (String(text || '').match(CODE_PATH_RE) || []).length > 0;
}

/**
 * True if the fix is EXCLUSIVELY workflow-scoped (requires editing `.github/workflows/**`),
 * so promoting it would burn quota on a run the push would block anyway. Pure → testable.
 * @param {string} text  title + body of the issue
 */
export function detectWorkflowScoped(text) {
  const s = String(text || '');
  const wfFull = s.match(WORKFLOW_PATH_RE) || [];
  const bareYml = (s.match(BARE_YML_RE) || []).filter(
    (y) => !NON_WORKFLOW_YML.has(y.toLowerCase()),
  );
  const workflowRefs = [...new Set([...wfFull, ...bareYml])];
  if (workflowRefs.length === 0) return false; // no workflow reference → promote
  if (hasNonWorkflowCodeRefs(s)) return false; // also cites non-workflow code → might fix there → promote
  return true; // workflow-only → blocked-workflows-scope by construction
}
