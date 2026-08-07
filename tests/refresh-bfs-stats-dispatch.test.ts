/**
 * Invariants of refresh-bfs-stats.yml's article-dispatch step (issue #5297).
 *
 * The failure this pins is a loop, not a one-off. refresh-bfs-stats.mjs
 * re-emits `new_quarter` on EVERY run until the quarter's article is registered
 * in data/article-source-urls.json (its "Quarter invariato ma articolo non
 * ancora pubblicato" branch), and that registration can only be produced by
 * generate-article.yml — which is `disabled_manually` for the duration of the
 * generator cutover to nanako (issue #4974, docs/articles-generator-migration.md
 * §5: "cut over last"). So the dispatch answers HTTP 422 "Cannot trigger a
 * 'workflow_dispatch' on a disabled workflow", the job goes red, and the same
 * CI-failure issue re-opens twice a day, indefinitely, for a job whose actual
 * work — writing the BFS dataset to Firestore — succeeded several steps earlier.
 *
 * Two ways the fix regresses silently, one test each:
 *   1) the degradation is widened into "any dispatch error is fine", which
 *      would hide a dead token or a bad ref forever;
 *   2) the Firestore refresh itself picks up the same tolerance and stops being
 *      able to fail — the one thing in this workflow that must stay loud.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(resolve('.github/workflows/refresh-bfs-stats.yml'), 'utf8');

const DISPATCH_STEP = 'Dispatch generate-article (new quarter only)';
const dispatchBlock = workflow.slice(workflow.indexOf(DISPATCH_STEP));

describe('refresh-bfs-stats: a disabled dispatch target is not a failure', () => {
  it('has the step at all, and it still dispatches on the happy path', () => {
    expect(workflow).toContain(DISPATCH_STEP);
    expect(dispatchBlock).toMatch(/gh workflow run generate-article\.yml/);
  });

  it('degrades to a ::warning:: instead of failing the job', () => {
    // The whole point: a workflow that fails every night is noise that hides
    // real breakage. `::warning::` keeps the skip visible as an annotation
    // without going red.
    expect(dispatchBlock).toContain('::warning::');
    // and it must actually pass — a warning followed by a non-zero exit is
    // the same red build with extra text.
    expect(dispatchBlock).toMatch(/::warning::[\s\S]{0,900}?\n\s*exit 0/);
  });

  it('reads the workflow state from the API rather than grepping the 422 text', () => {
    // `.state` is a machine-readable enum; the 422 prose is not. Matching on
    // the message means a GitHub reword turns a known no-op back into a
    // nightly red build, silently.
    expect(dispatchBlock).toMatch(/gh api[\s\S]{0,200}actions\/workflows\/generate-article\.yml/);
    expect(dispatchBlock).toMatch(/--jq '\.state'/);
    expect(dispatchBlock).not.toMatch(/grep[^\n]*disabled workflow/i);
  });

  it('still fails when the target is active — the degradation is narrow', () => {
    // A bad token, a missing ref or a rate limit all leave state == "active".
    // Those must keep failing the job exactly as before.
    expect(dispatchBlock).toMatch(/\[ "\$STATE" != "active" \]/);
    expect(dispatchBlock).toMatch(/::error::[\s\S]{0,200}?exit 1/);
  });

  it('does not treat an unreadable state as "disabled"', () => {
    // Swallowing the lookup's own failure (`|| echo unknown`, or `2>/dev/null`
    // feeding a bare != "active" test) turns a 403 from a token without the
    // actions scope into a blanket pass on EVERY dispatch failure — the exact
    // opposite of a narrow degradation.
    expect(dispatchBlock).toMatch(/if ! STATE="\$\(gh api/);
    expect(dispatchBlock).not.toMatch(/\|\|\s*echo\s*'?unknown/);
  });

  it('leaves the Firestore refresh itself able to fail', () => {
    // The dataset write is the job's actual product and has no tolerance
    // wrapper; only the downstream announcement dispatch is best-effort.
    expect(workflow).toMatch(/- name: Refresh BFS stats\n\s+id: refresh\n\s+run: node scripts\/refresh-bfs-stats\.mjs\n/);
    const refreshIdx = workflow.indexOf('- name: Refresh BFS stats');
    const refreshBlock = workflow.slice(refreshIdx, workflow.indexOf('- name: Job summary'));
    expect(refreshBlock).not.toContain('continue-on-error');
    expect(refreshBlock).not.toContain('::warning::');
  });

  it('can read the workflow state with the permissions it declares', () => {
    // `gh api .../actions/workflows/<file>` needs the actions scope; without it
    // the state lookup 403s, falls back to "unknown", and the job would then
    // pass on a genuine dispatch failure too.
    expect(workflow).toMatch(/permissions:[\s\S]{0,200}actions:\s*write/);
  });
});
