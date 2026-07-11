/**
 * Lock the path-extraction logic of the zero-Claude workflows-scope pre-flight gate
 * (scripts/ci/check-workflows-scope.mjs). Structural fix for escalation #3887.
 *
 * The gate runs BEFORE Claude in issue-fix.yml to short-circuit issues that explicitly
 * cite .github/workflows/** files. It is intentionally CONSERVATIVE (PROCEED-SAFE):
 * only explicit backtick refs and code-block paths trigger a block; plain prose and
 * bare .yml names are passed through (the pre-commit hook and drainer's detectWorkflowScoped
 * handle broader detection).
 */
import { describe, it, expect } from 'vitest';
import { extractWorkflowPaths } from '../scripts/ci/check-workflows-scope.mjs';

describe('extractWorkflowPaths — BLOCKED (explicit .github/workflows/** paths)', () => {
  it('detects backtick ref with full .github/workflows/ prefix', () => {
    const body = 'Suggested action: in `.github/workflows/traffic-scheduler.yml`, change the cron.';
    const paths = extractWorkflowPaths(body);
    expect(paths).toContain('.github/workflows/traffic-scheduler.yml');
  });

  it('detects multiple backtick refs', () => {
    const body = [
      'Edit `.github/workflows/issue-fix.yml` and `.github/workflows/issue-triage.yml`.',
    ].join('\n');
    const paths = extractWorkflowPaths(body);
    expect(paths).toContain('.github/workflows/issue-fix.yml');
    expect(paths).toContain('.github/workflows/issue-triage.yml');
  });

  it('detects path inside a fenced code block (``` fence)', () => {
    const body = [
      'Change the following file:',
      '```yaml',
      '.github/workflows/post-deploy-validate-dist.yml',
      '```',
    ].join('\n');
    const paths = extractWorkflowPaths(body);
    expect(paths).toContain('.github/workflows/post-deploy-validate-dist.yml');
  });

  it('detects path inside a ~~~ fenced code block', () => {
    const body = ['~~~', '.github/workflows/crawler-group-01.yml', '~~~'].join('\n');
    const paths = extractWorkflowPaths(body);
    expect(paths).toContain('.github/workflows/crawler-group-01.yml');
  });

  it('detects "file: .github/workflows/..." annotation inside a code block', () => {
    const body = ['```', '# file: .github/workflows/deploy.yml', '```'].join('\n');
    const paths = extractWorkflowPaths(body);
    expect(paths).toContain('.github/workflows/deploy.yml');
  });
});

describe('extractWorkflowPaths — PROCEED (no explicit workflow path)', () => {
  it('does NOT trigger on plain prose mentioning "traffic-scheduler workflow"', () => {
    const body = 'The traffic-scheduler workflow has a scheduling gap. Self-heal dispatched traffic-scheduler.';
    expect(extractWorkflowPaths(body)).toHaveLength(0);
  });

  it('does NOT trigger on a bare .yml name without .github/workflows/ prefix', () => {
    const body = 'Fix the rate-limit in `orchestrate-crawlers.yml` dispatch loop.';
    expect(extractWorkflowPaths(body)).toHaveLength(0);
  });

  it('does NOT trigger on prose that mentions "workflows" generically', () => {
    const body = 'The issue-fix workflow was failing. The workflows scope is missing.';
    expect(extractWorkflowPaths(body)).toHaveLength(0);
  });

  it('does NOT trigger on code block with non-workflow .yml files', () => {
    const body = ['```', 'lighthouserc.yml', 'vitest.config.ts', '```'].join('\n');
    expect(extractWorkflowPaths(body)).toHaveLength(0);
  });

  it('does NOT trigger on .github/ paths outside workflows/ (e.g. .github/actions/)', () => {
    const body = 'Edit `.github/actions/setup-headroom/action.yml` for the proxy.';
    expect(extractWorkflowPaths(body)).toHaveLength(0);
  });

  it('returns empty array for empty/undefined body', () => {
    expect(extractWorkflowPaths('')).toHaveLength(0);
    expect(extractWorkflowPaths(undefined as unknown as string)).toHaveLength(0);
  });
});
