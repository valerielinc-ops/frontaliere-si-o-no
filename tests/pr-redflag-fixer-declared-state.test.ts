import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import * as sections from '../scripts/lib/pr-body-sections-check.mjs';

/**
 * Guardrail for issue #5917.
 *
 * Both autonomous fixers — `pr-redflag-fixer.yml` (closes 🔴 findings on a PR)
 * and `issue-fix.yml` (implements a backlog issue, most often a follow-up born
 * from a PR's own residuals) — were told to APPLY a fix without ever being told
 * to READ the states already declared in `## Non implementato (ancora)`.
 *
 * Since #5916 those bullets carry one of five literal states, and two of them —
 * `per scelta` / `by construction` — are not deferred work: they are a motivated
 * NO. A fixer that cannot see them re-opens a point that was closed on purpose,
 * contradicts a decision already taken, and burns a round (or a whole issue-fix
 * run) on work nobody wants.
 *
 * The instruction must also REUSE the taxonomy rather than restate it:
 * `extractSection` + `bulletState` live in `scripts/lib/pr-body-sections-check.mjs`
 * and `scripts/ci/followup-has-candidates.mjs` already imports from there. A
 * second, hand-written parser in a prompt is the classic silent divergence —
 * the gate would judge the body by one taxonomy while the fixer reasons with
 * another.
 *
 * This test is a source scan of the two YAML prompts. It goes red the moment the
 * instruction disappears from EITHER of them, and red as well if the module or
 * the two functions it names stop existing (a prompt that points at a renamed
 * helper is an instruction the agent cannot follow).
 */

const ROOT = process.cwd();
const HELPER_MODULE = 'scripts/lib/pr-body-sections-check.mjs';

/** The two fixer prompts, keyed by workflow file name. */
const FIXERS = ['pr-redflag-fixer.yml', 'issue-fix.yml'] as const;

/** The `with.prompt` of every `anthropics/claude-code-action` step in a workflow. */
function claudePrompts(file: string): string[] {
  const doc: any = YAML.parse(readFileSync(join(ROOT, '.github/workflows', file), 'utf8'));
  const out: string[] = [];
  for (const job of Object.values<any>(doc?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (typeof step?.uses === 'string' && step.uses.startsWith('anthropics/claude-code-action')) {
        const p = step?.with?.prompt;
        if (typeof p === 'string') out.push(p);
      }
    }
  }
  return out;
}

/**
 * The prompt text of a fixer workflow.
 *
 * Deliberately taken from the parsed `with.prompt`, not from the raw file: a
 * YAML comment mentioning the helper would satisfy a grep over the file while
 * the agent never reads it. Only what reaches the model counts.
 */
function fixerPrompt(file: string): string {
  const prompts = claudePrompts(file);
  expect(prompts.length, `no claude-code-action prompt found in ${file}`).toBeGreaterThan(0);
  return prompts.join('\n');
}

describe('the autonomous fixers read declared states before contradicting them (#5917)', () => {
  it('the scanner reaches a real prompt in both workflows', () => {
    for (const file of FIXERS) {
      const prompt = fixerPrompt(file);
      // Anti-vacuity: these prompts are long operating contracts. A few hundred
      // chars would mean the YAML shape changed and the scan is looking at the
      // wrong node.
      expect(prompt.length, `${file}: prompt suspiciously short`).toBeGreaterThan(1000);
    }
  });

  it.each(FIXERS)('%s tells the agent to read `## Non implementato (ancora)` first', (file) => {
    const prompt = fixerPrompt(file);
    expect(
      prompt,
      `${file}: the prompt no longer instructs the agent to read the CURRENT ` +
        '`## Non implementato (ancora)` before applying a fix (#5917).',
    ).toMatch(/Non implementato \(ancora\)/);
    // It must read the body from the live PR, not guess it.
    expect(prompt, `${file}: the prompt does not load a PR body with \`gh pr view … --json body\`.`)
      .toMatch(/gh pr view[^\n]*--json[^\n]*body/);
  });

  it.each(FIXERS)('%s reuses extractSection + bulletState instead of a second parser', (file) => {
    const prompt = fixerPrompt(file);
    expect(
      prompt,
      `${file}: the prompt no longer points at ${HELPER_MODULE}. Without it the ` +
        'agent writes its own state parser and diverges from the gate that ' +
        'judges the body (#5917).',
    ).toContain(HELPER_MODULE);
    expect(prompt, `${file}: \`extractSection\` is not named in the prompt.`).toMatch(
      /\bextractSection\b/,
    );
    expect(prompt, `${file}: \`bulletState\` is not named in the prompt.`).toMatch(/\bbulletState\b/);
    // And it must say NOT to hand-roll one — the whole point of the reuse.
    expect(
      prompt,
      `${file}: the prompt no longer forbids writing a second parser.`,
    ).toMatch(/NON scrivere un secondo parser/i);
  });

  it.each(FIXERS)('%s honours `per scelta` / `by construction` as closed, with a motive', (file) => {
    const prompt = fixerPrompt(file);
    expect(prompt, `${file}: \`per scelta\` is not named as a closing state.`).toMatch(
      /per scelta/i,
    );
    expect(prompt, `${file}: \`by construction\` is not named as a closing state.`).toMatch(
      /by construction/i,
    );
    expect(
      prompt,
      `${file}: the prompt no longer requires a MOTIVE alongside the closing state — ` +
        'a bare state word would let any bullet veto any finding.',
    ).toMatch(/con un motivo/i);
  });

  it('the helper the prompts point at really exports the two functions they name', () => {
    // A prompt that references a renamed helper is an instruction the agent
    // cannot follow, and nothing else in CI would notice.
    expect(typeof (sections as any).extractSection).toBe('function');
    expect(typeof (sections as any).bulletState).toBe('function');

    // And the states the prompts treat as CLOSING must be the ones the taxonomy
    // actually returns — otherwise the instruction is written against a
    // vocabulary that no longer exists.
    expect((sections as any).bulletState('- niente shard: il gate lo copre già — per scelta')).toBe(
      'by-choice',
    );
    expect((sections as any).bulletState('- nessun parser nuovo — by construction')).toBe(
      'by-construction',
    );
    // A bullet with a NON-closing state must not read as closed: those findings
    // still have to be fixed.
    expect((sections as any).bulletState('- il resto — in questa PR')).toBe('in-this-pr');
    expect((sections as any).bulletState('- attende il corpus — blocked: repo gemello')).toBe(
      'blocked-technical',
    );
  });

  it('followup-has-candidates.mjs still imports the same helper (the precedent cited)', () => {
    // The prompts justify the reuse by pointing at this file. If it ever stops
    // importing the module, the justification is stale and the instruction
    // should be rewritten rather than left citing a precedent that is gone.
    const src = readFileSync(join(ROOT, 'scripts/ci/followup-has-candidates.mjs'), 'utf8');
    expect(src).toMatch(/from\s+'[^']*pr-body-sections-check\.mjs'/);
    expect(src).toMatch(/\bbulletState\b/);
  });
});
