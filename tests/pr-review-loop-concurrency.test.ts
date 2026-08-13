import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

/**
 * Observer for issue #5614 (site half) — pr-review-loop.yml's concurrency
 * group was keyed on `head_branch` alone. `tests.yml` on the site triggers on
 * `pull_request`, `push` (branches:[main]) AND `workflow_dispatch` — the last
 * one is what `pr-autorebase.yml` uses to re-run `tests` on a freshly rebased
 * PR head (a PAT push to a PR branch does not reliably re-trigger
 * `pull_request` workflows, see tests.yml's own comment). That dispatch-
 * triggered `tests` run completes and fires `workflow_run` with the SAME
 * `head_branch` as the genuine `pull_request`-triggered run for that PR — same
 * concurrency slot, and with `cancel-in-progress: true` one kills the other.
 *
 * The damage is asymmetric, not random: the job's own `if:` gate below
 * requires `workflow_run.event == 'pull_request'`, so the dispatch-sourced run
 * is ALWAYS the one whose job body is a no-op. If it lands SECOND, it still
 * cancels the real review in progress — and leaves nothing in its place, since
 * its own job never runs either. Not an error anywhere, just a review that
 * silently never happens.
 *
 * Measured on the site: 1 `cancelled` out of the last 200 `pr-review-loop`
 * runs (`gh run list --repo valerielinc-ops/frontaliere-si-o-no
 * --workflow=pr-review-loop.yml --limit 200 --json conclusion`). Rarer than
 * the corpus's 25/400 (frontaliere-articles#286, where `tests.yml` also runs
 * on push to non-main branches) but the same mechanism — a premise this repo
 * previously believed did NOT apply here turned out to be wrong.
 *
 * Fix mirrors the corpus (#286): fold `github.event.workflow_run.event` into
 * the group, so a `pull_request`-triggered review and a `workflow_dispatch`-
 * triggered no-op land in different groups and stop colliding. (The corpus
 * group also folds in `github.event_name`/`inputs.pr` — not needed here,
 * because unlike the corpus, this file has no `workflow_dispatch` trigger of
 * its OWN; that part of #286 answers a different issue, #201, which the site
 * does not have.)
 */

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(ROOT, '.github/workflows/pr-review-loop.yml');
const WORKFLOW_YML = readFileSync(WORKFLOW_PATH, 'utf-8');

/** True iff a concurrency-group string discriminates the upstream `tests` trigger. */
function groupIncludesEvent(group: string): boolean {
  return group.includes('workflow_run.event');
}

describe('pr-review-loop.yml — concurrency group includes the event (issue #5614)', () => {
  const doc = YAML.parse(WORKFLOW_YML);

  it('parses and has a top-level concurrency.group', () => {
    expect(typeof doc.concurrency?.group).toBe('string');
  });

  it('the concurrency group names workflow_run.event, not just the branch', () => {
    const group: string = doc.concurrency.group;
    expect(groupIncludesEvent(group), `group was: ${group}`).toBe(true);
  });

  it('still keys on head_branch too — PRs on different branches must not collide', () => {
    const group: string = doc.concurrency.group;
    expect(group).toMatch(/workflow_run\.head_branch/);
  });

  it('cancel-in-progress is still true — newest-wins is correct once the two events cannot land in the same group', () => {
    expect(doc.concurrency['cancel-in-progress']).toBe(true);
  });

  it('is NOT vacuous: reverting the group to the pre-fix (branch-only) form fails the check above — proven against the real file text', () => {
    // Applies the exact inverse of this PR's edit to the REAL file contents
    // (not a hand-copied literal) and re-runs the SAME extraction + predicate
    // used by the passing test above. If someone reverts pr-review-loop.yml's
    // concurrency group, this is the assertion that goes red.
    const preFixLine = 'group: pr-review-${{ github.event.workflow_run.head_branch }}';
    const postFixLine =
      'group: pr-review-${{ github.event.workflow_run.event }}-${{ github.event.workflow_run.head_branch }}';
    expect(WORKFLOW_YML, 'the current file no longer contains the exact post-fix line — update this test').toContain(
      postFixLine,
    );
    const mutated = WORKFLOW_YML.replace(postFixLine, preFixLine);
    expect(mutated, 'the replace did not change anything').not.toBe(WORKFLOW_YML);
    const mutatedGroup: string = YAML.parse(mutated).concurrency.group;
    expect(groupIncludesEvent(mutatedGroup)).toBe(false);
  });

  it('the job gate still filters on workflow_run.event == pull_request — this is WHY a dispatch-sourced run in the same slot cancels the review and leaves nothing behind', () => {
    const reviewJob = doc.jobs.review;
    expect(String(reviewJob.if)).toMatch(/workflow_run\.event\s*==\s*'pull_request'/);
  });
});
