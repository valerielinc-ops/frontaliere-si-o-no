import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/issue-fix.yml', import.meta.url), 'utf8');

describe('issue-fix FIX_OUTCOME backstop', () => {
  it('non lascia che un marker storico sopprima il run corrente', () => {
    expect(workflow).toMatch(/permissions:\n(?:  .*\n)*  actions: read\n/);
    expect(workflow).toContain('RUN_STARTED_AT=$(gh api "repos/$REPO/actions/runs/$GITHUB_RUN_ID"');
    expect(workflow).toContain("--jq '.run_started_at // .created_at'");
    expect(workflow).toContain('--arg started "$RUN_STARTED_AT"');
    expect(workflow).toContain('.createdAt // "") >= $started');
    expect(workflow).toMatch(
      /RUN_STARTED_AT non disponibile: backstop non emesso\.[\s\S]*?\n\s+exit 0\n\s+fi/,
    );
    expect(workflow).not.toContain(
      '--jq \'[.comments[].body | select(test("<!-- FIX_OUTCOME:"))] | length\'',
    );
  });
});

describe('issue-fix PR delivery verification', () => {
  it('fails closed after a recorded best-effort body write failure without a PR', () => {
    const start = workflow.indexOf('- name: Verify best-effort PR writes (zero-Claude)');
    const end = workflow.indexOf('- name:', start + 1);
    const verificationStep = workflow.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(workflow).toContain('PR_BODY_GATE_STATUS_FILE=$status_file');
    expect(workflow).toContain('PR_BODY_GATE_BASELINE_FILE=$baseline_file');
    expect(verificationStep).toContain('status_file="${PR_BODY_GATE_STATUS_FILE:-}"');
    expect(verificationStep).toContain('baseline_file="${PR_BODY_GATE_BASELINE_FILE:-}"');
    expect(verificationStep).toContain('CLAUDE_OUTCOME: ${{ steps.claude_review.outcome }}');
    expect(verificationStep).toContain('claude_outcome');
    expect(verificationStep).toContain('grep -Fxq \'best-effort-failed\' "$status_file"');
    expect(verificationStep).toContain('grep -Fxq "$candidate" "$baseline_file"');
    expect(verificationStep).toContain('gh pr list --repo "$REPO" --head "$BRANCH" --state all');
    expect(verificationStep).toContain('echo "::error::gh-pr-body-check ha registrato');
    expect(verificationStep).toContain('exit 1');
    expect(verificationStep).not.toContain('continue-on-error: true');
    expect(end).toBeGreaterThan(start);
    expect(workflow.indexOf('Classify outcome (work-done, not CLI exit)')).toBeGreaterThan(end);
  });
});
