import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const workflowSource = readFileSync(
  new URL('../.github/workflows/issue-triage.yml', import.meta.url),
  'utf8',
);
const workflow = parse(workflowSource) as {
  jobs?: {
    triage?: {
      if?: unknown;
      steps?: Array<{ name?: string; run?: unknown }>;
    };
  };
};
const triage = workflow.jobs?.triage;
const classifyAndRoute = triage?.steps?.find(
  (step) => step.name === 'Classify and route (deterministic, no Claude)',
)?.run;

describe('issue-triage startup race', () => {
  it('always materializes the event-driven job before checking mutable labels', () => {
    expect(triage?.if).toBe("${{ github.event_name == 'issues' }}");
    expect(String(triage?.if)).not.toContain('github.event.issue.labels');
  });

  it('uses the live issue snapshot for the anti-loop no-op', () => {
    const script = String(classifyAndRoute);
    const liveRead = script.indexOf('gh issue view "$ISSUE_NUMBER"');
    const liveGuard = script.indexOf('already_triaged=$(jq -r');
    const noOp = script.indexOf('if [ "$already_triaged" = "true" ]; then');
    const labelMutation = script.indexOf('gh issue edit "$ISSUE_NUMBER" --repo "$REPO" --add-label "agent:triaged"');

    expect(liveRead).toBeGreaterThanOrEqual(0);
    expect(liveGuard).toBeGreaterThan(liveRead);
    expect(noOp).toBeGreaterThan(liveGuard);
    expect(noOp).toBeLessThan(labelMutation);
    expect(script.slice(noOp, labelMutation)).toContain('exit 0');
  });
});
