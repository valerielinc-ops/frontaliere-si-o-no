import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const WORKFLOW = '.github/workflows/tests.yml';
const ACTION = '.github/actions/claude-codex-fallback/action.yml';

describe('tests workflow — Codex Luna Max is fixed at runtime', () => {
  it('uses the pinned Codex CLI with max reasoning and no Claude runtime guard', () => {
    const source = readFileSync(WORKFLOW, 'utf8');
    const action = readFileSync(ACTION, 'utf8');
    const doc: any = YAML.parse(source);
    const steps = Object.values<any>(doc.jobs ?? {})
      .flatMap((job: any) => job.steps ?? []);
    const review = steps.find((step: any) => step.id === 'codex_review');

    expect(review, `missing Codex review step in ${WORKFLOW}`).toBeTruthy();
    expect(action).toContain('name: "Codex Luna Max primary"');
    expect(action).toContain('--model gpt-5.6-luna');
    expect(action).toContain('-c model_reasoning_effort=max');
    expect(steps.some((step: any) => step.id === 'claude_effort')).toBe(false);
    expect(action).not.toContain('claude --effort');
  });
});
