import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const drainer = readFileSync(new URL('../.github/workflows/followup-drainer.yml', import.meta.url), 'utf8');
const recycle = readFileSync(new URL('../.github/workflows/recycle-stale-prs.yml', import.meta.url), 'utf8');

function stepBody(workflow: string, name: string, nextName: string): string {
  const start = workflow.indexOf(`- name: ${name}`);
  const end = workflow.indexOf(`- name: ${nextName}`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

describe('follow-up token loading and stale recycle guards', () => {
  it.each([
    ['drainer', drainer, 'Load secrets from Remote Config', 'Alert token-down (dedup, zero-Claude)'],
    ['recycle', recycle, 'Load secrets from Remote Config (GITHUB_PAT)', 'Alert token-down (dedup, zero-Claude)'],
  ])('%s does not run the alert before the RC loader has executed', (_name, workflow, loaderName, alertName) => {
    const loader = stepBody(workflow, loaderName, alertName);
    const alert = workflow.slice(workflow.indexOf(`- name: ${alertName}`));
    expect(loader).toContain('id: load_rc_env');
    expect(alert).toContain("if: always() && steps.load_rc_env.outcome != 'skipped'");
  });

  it('re-reads stale-review veto labels immediately before recycling a PR', () => {
    const recycleStep = stepBody(recycle, 'Recycle deeply-stale stale-review PRs', 'Flag parked draft PRs');
    expect(recycleStep).toContain('LIVE_LABELS=$(bounded gh pr view "$N" --repo "$REPO" --json labels');
    expect(recycleStep).toContain('agent:resolving-conflict');
    expect(recycleStep).toContain('stale-review');
    expect(recycleStep).toContain('fail-closed');
  });
});
