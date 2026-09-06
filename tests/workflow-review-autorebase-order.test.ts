import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8');
const autoMergeEval = readFileSync(new URL('../scripts/ci/auto-merge-eval.mjs', import.meta.url), 'utf8');
const nativeAutoMerge = readFileSync(new URL('../.github/workflows/enable-native-automerge.yml', import.meta.url), 'utf8');

describe('review → autorebase ordering', () => {
  it('keeps autorebase behind an approving LGTM gate', () => {
    const reviewGate = workflow.indexOf('id: review_gate');
    const autorebase = workflow.indexOf('Rebase near-merge PRs after approved review');

    expect(reviewGate).toBeGreaterThanOrEqual(0);
    expect(autorebase).toBeGreaterThan(reviewGate);
    expect(workflow).toContain("steps.review_gate.outputs.approved == 'true'");
  });

  it('does not allow the drift fallback to approve a PR without LGTM', () => {
    expect(autoMergeEval).toContain("Nessuna review claude-bot approvante");
    expect(autoMergeEval).not.toContain('if (!evaluateDriftFallback())');
  });

  it('keeps Claude Important findings inside the required native-merge check', () => {
    expect(workflow).toContain('name: vitest (unit + integration)');
    expect(workflow).toContain('id: review_gate');
    expect(workflow).toContain('!REDFLAG_IMPORTANT_RE.test(body)');
    expect(nativeAutoMerge).toContain('gh pr merge "$PR_NUMBER" --repo "$REPOSITORY" --auto');
    expect(nativeAutoMerge).not.toContain('auto-merge-eval.mjs');
  });

  it('review_gate still runs when claude_review has outcome == failure (no outcome != failure skip)', () => {
    const start = workflow.indexOf('id: review_gate');
    expect(start).toBeGreaterThanOrEqual(0);
    const gateBlock = workflow.slice(start, start + 1200);
    const ifLine = gateBlock.split('\n').find((l) => /^\s+if:/.test(l));
    expect(ifLine, 'review_gate must have a job-step if:').toBeTruthy();
    expect(ifLine).toContain('always()');
    expect(ifLine).toContain("steps.resolve.outputs.should_review == 'true'");
    expect(ifLine).not.toMatch(/steps\.claude_review\.outcome\s*!=\s*'failure'/);
  });
});
