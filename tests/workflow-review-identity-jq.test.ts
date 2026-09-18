import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8');

function workflowStepContaining(needle: string): string {
  const index = workflow.indexOf(needle);
  if (index < 0) throw new Error('Workflow step not found: ' + needle);
  const start = workflow.lastIndexOf('\n      - name:', index);
  const end = workflow.indexOf('\n      - name:', index + needle.length);
  return workflow.slice(start, end < 0 ? workflow.length : end);
}

function reviewJqFilters(): string[] {
  return workflow.split('\n')
    .filter((line) => line.includes('--jq') && line.includes('.user.login'))
    .map((line) => line.match(/--jq '([^']+)'/)?.[1] || '');
}

function runJq(filter: string, input: unknown): string {
  const result = spawnSync('jq', ['-r', filter], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe('tests.yml review identity jq contract', () => {
  it('accepts valid logins without trusting variable REST type metadata', () => {
    const filters = reviewJqFilters();
    expect(filters).toHaveLength(1);
    for (const filter of filters) {
      expect(filter).not.toContain('.user.type');
    }

    const reviews = [
      {
        user: { login: 'frontaliere-automation[bot]', type: 'User' },
        body: '## LGTM',
        commit_id: 'app-commit',
      },
      {
        user: { login: 'claude[bot]' },
        body: 'review without LGTM',
        commit_id: 'claude-commit',
      },
      {
        user: { login: 'claude', type: 'Bot' },
        body: '## LGTM',
        commit_id: 'bare-claude',
      },
      {
        user: { login: 'frontaliere-automation-evil[bot]', type: 'Bot' },
        body: '## LGTM',
        commit_id: 'lookalike',
      },
    ];

    // Skip/admission moved to pr-review-admission.mjs. The remaining jq is the
    // incremental re-review base query and must keep the same exact allowlist.
    expect(runJq(filters[0], reviews)).toBe('claude-commit');
  });

  it('keeps the review gate blocking without a quota admission step', () => {
    const gate = workflowStepContaining('id: review_gate');
    const abort = workflowStepContaining('id: review_abort');

    expect(gate).toContain('node scripts/ci/review-gate.mjs');
    expect(gate).not.toContain('continue-on-error: true');
    expect(abort).not.toContain('continue-on-error: true');
    expect(workflow).not.toContain('id: quota');
    expect(workflow).not.toContain('check-quota-backoff.mjs');
    expect(workflow).not.toContain('name: Claude usage metrics');
  });
});
