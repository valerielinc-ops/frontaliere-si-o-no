import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const WORKFLOW = '.github/workflows/tests.yml';

describe('tests workflow — Claude effort is checked on the runtime CLI (#7267)', () => {
  it('checks the action-installed CLI after the review action succeeds', () => {
    const source = readFileSync(WORKFLOW, 'utf8');
    const doc: any = YAML.parse(source);
    const steps = Object.values<any>(doc.jobs ?? {})
      .flatMap((job: any) => job.steps ?? []);
    const index = steps.findIndex((step: any) => step.id === 'claude_review');
    const guard = steps.find((step: any) => step.id === 'claude_effort');

    expect(index, `missing Claude review step in ${WORKFLOW}`).toBeGreaterThanOrEqual(0);
    expect(guard, `missing runtime effort guard in ${WORKFLOW}`).toBeTruthy();
    expect(guard.run).toContain('claude --effort medium --version');
    expect(guard.run).toMatch(/unknown.{0,20}--effort|--effort.{0,20}unknown|unknown option.{0,20}effort/i);
    expect(guard.if).toContain("steps.claude_review.outcome == 'success'");
    expect(steps.indexOf(guard)).toBeGreaterThan(index);
  });
});
