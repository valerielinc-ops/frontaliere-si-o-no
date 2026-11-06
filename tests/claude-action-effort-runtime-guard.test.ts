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
    expect(action).toContain('-c "model_reasoning_effort=$codex_reasoning_effort"');
    expect(steps.some((step: any) => step.id === 'claude_effort')).toBe(false);
    expect(action).not.toContain('claude --effort');
  });

  it('defaults the action to max and lets only the review choose high per tier', () => {
    const action: any = YAML.parse(readFileSync(ACTION, 'utf8'));
    expect(action.inputs.reasoning_effort.default).toBe('max');
    const source = readFileSync(ACTION, 'utf8');
    expect(source).toContain('high|max) ;;');
    expect(source).toContain('EVIDENCE_EFFORT="${CODEX_REASONING_EFFORT:-max}"');

    const doc: any = YAML.parse(readFileSync(WORKFLOW, 'utf8'));
    const steps = Object.values<any>(doc.jobs ?? {}).flatMap((job: any) => job.steps ?? []);
    const review = steps.find((step: any) => step.id === 'codex_review');
    expect(review.with.reasoning_effort).toBe("${{ steps.tier.outputs.effort || 'max' }}");
    const tier = steps.find((step: any) => step.id === 'tier');
    expect(tier.run).toContain('case "$1" in high|high-mega) effort=max ;; esac');
    expect(tier.run).toContain('echo "effort=$effort"');
  });

  it('keeps max for every other caller of the action', () => {
    const workflows = ['issue-fix.yml', 'pr-redflag-fixer.yml', 'pr-redcheck-fixer.yml'];
    for (const name of workflows) {
      let text = '';
      try { text = readFileSync(`.github/workflows/${name}`, 'utf8'); } catch { continue; }
      expect(text, name).not.toContain('reasoning_effort:');
    }
  });
});
