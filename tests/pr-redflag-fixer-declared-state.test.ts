import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import * as sections from '../scripts/lib/pr-body-sections-check.mjs';
import { isCandidateItem } from '../scripts/ci/followup-has-candidates.mjs';

/**
 * Guardrail for issue #5917.
 *
 * Both autonomous fixers — `pr-redflag-fixer.yml` (closes 🔴 findings on a PR)
 * and `issue-fix.yml` (implements a backlog issue, most often a follow-up born
 * from a PR's own residuals) — were told to APPLY a fix without ever being told
 * to READ the states already declared in `## Non implementato (ancora)`.
 *
 * Since #5916 those bullets carry one of six literal states, and three of them —
 * `per scelta`, `by construction`, `blocked: decisione del proprietario` — are
 * not deferred work: they are a motivated NO. A fixer that cannot see them
 * re-opens a point closed on purpose and burns a round on work nobody wants.
 *
 * Four things this file pins beyond "the instruction exists", each one a defect
 * the first version of the fix still had:
 *
 *  1. the taxonomy module must be resolved from `main`. These jobs are
 *     checked out on the branch UNDER FIX, which can predate #5916 — importing
 *     it from the checkout dies `SyntaxError`/`ERR_MODULE_NOT_FOUND` mid-round;
 *  2. the prompts must name `sectionBullets`/`stripNonContent` and
 *     `NON_IMPL_ANCORA_RE`, not just `extractSection`/`bulletState`: without the
 *     stripping, the taxonomy EXAMPLES inside a fenced block of the body read as
 *     declared states, and `extractSection` cannot even be called without the
 *     header regex;
 *  3. `blocked:` is not monolithic — `blocked-owner` closes the item and
 *     `blocked-technical` does not, and the two fixers must decide the same way
 *     `followup-has-candidates.mjs` does;
 *  4. the EMITTER of the 🔴 has to know the taxonomy too. A reviewer that keeps
 *     raising the same 🔴 on a `per scelta` bullet burns MAX_ROUNDS and escalates
 *     to `needs-human` with the wrong diagnosis, because the fixer legitimately
 *     declines every time.
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
 * The prompt text of a workflow.
 *
 * Deliberately taken from the parsed `with.prompt`, not from the raw file: a
 * YAML comment mentioning the helper would satisfy a grep over the file while
 * the agent never reads it. Only what reaches the model counts.
 */
function prompt(file: string): string {
  const prompts = claudePrompts(file);
  expect(prompts.length, `no claude-code-action prompt found in ${file}`).toBeGreaterThan(0);
  return prompts.join('\n');
}

describe('the autonomous fixers read declared states before contradicting them (#5917)', () => {
  it('the scanner reaches a real prompt in both workflows', () => {
    for (const file of FIXERS) {
      // Anti-vacuity: these prompts are long operating contracts. A few hundred
      // chars would mean the YAML shape changed and the scan is looking at the
      // wrong node.
      expect(prompt(file).length, `${file}: prompt suspiciously short`).toBeGreaterThan(1000);
    }
  });

  it.each(FIXERS)('%s tells the agent to read `## Non implementato (ancora)` first', (file) => {
    const p = prompt(file);
    expect(
      p,
      `${file}: the prompt no longer instructs the agent to read the CURRENT ` +
        '`## Non implementato (ancora)` before applying a fix (#5917).',
    ).toMatch(/Non implementato \(ancora\)/);
    expect(p, `${file}: the prompt does not load a PR body with \`gh pr view … --json body\`.`)
      .toMatch(/gh pr view[^\n]*--json[^\n]*body/);
  });

  it.each(FIXERS)('%s resolves the taxonomy module from main, not from the checkout', (file) => {
    const p = prompt(file);
    // `pr-redflag-fixer` checks out the head of the PR under fix; `issue-fix`
    // with `resume=true` checks out a branch left by an earlier run. Either can
    // predate #5916, where `bulletState` is not exported — the import then dies
    // after the diagnosis turns are already spent.
    expect(
      p,
      `${file}: the prompt no longer fetches ${HELPER_MODULE} from main. Resolved from ` +
        'the checkout, a pre-#5916 branch has no `bulletState` export (SyntaxError) ' +
        'or no file at all (ERR_MODULE_NOT_FOUND).',
    ).toMatch(/git show FETCH_HEAD:scripts\/lib\/pr-body-sections-check\.mjs/);
    expect(p, `${file}: the prompt no longer fetches origin/main before reading the module.`)
      .toMatch(/git fetch[^\n]*origin main/);
    // And it must not tell the agent to import the checkout's own copy.
    expect(
      p,
      `${file}: the prompt still imports the module from the checkout ("./scripts/lib/…"), ` +
        'which is the tree under fix — the wrong tree.',
    ).not.toMatch(/["']\.\/scripts\/lib\/pr-body-sections-check\.mjs["']/);
  });

  it.each(FIXERS)('%s reuses the four helpers by name instead of a second parser', (file) => {
    const p = prompt(file);
    expect(p, `${file}: the prompt no longer points at ${HELPER_MODULE}.`).toContain(HELPER_MODULE);
    for (const fn of ['extractSection', 'sectionBullets', 'bulletState', 'NON_IMPL_ANCORA_RE']) {
      expect(
        p,
        `${file}: \`${fn}\` is not named in the prompt. Without \`sectionBullets\` (which ` +
          'applies `stripNonContent`) the taxonomy EXAMPLES inside a fenced block of the ' +
          'body are read as declared states; without `NON_IMPL_ANCORA_RE` the agent has to ' +
          'hand-write the header regex `extractSection` requires.',
      ).toMatch(new RegExp(`\\b${fn}\\b`));
    }
    expect(p, `${file}: \`stripNonContent\` is no longer explained as the reason for the reuse.`)
      .toMatch(/stripNonContent/);
    expect(p, `${file}: the prompt no longer forbids writing a second parser.`).toMatch(
      /NON scrivere un secondo parser/i,
    );
  });

  it.each(FIXERS)('%s distinguishes blocked-owner (closing) from blocked-technical (open)', (file) => {
    const p = prompt(file);
    expect(
      p,
      `${file}: the prompt treats every \`blocked:\` alike. \`blocked: decisione del ` +
        'proprietario\` is in CLOSING_STATES — a definitive no — while any other cause is ' +
        'open work; a fixer that conflates them either re-opens a settled decision or ' +
        'silently drops real work.',
    ).toMatch(/blocked:\s*decisione del proprietario/i);
    expect(p, `${file}: \`blocked-technical\` is no longer named as NON-closing.`).toMatch(
      /blocked-technical/,
    );
    expect(p, `${file}: the prompt no longer says to read the CAUSE rather than the prefix.`)
      .toMatch(/monolitic/i);
  });

  it.each(FIXERS)('%s guards the veto against the earliest-match false positive', (file) => {
    const p = prompt(file);
    // `bulletState` returns the state whose match starts FIRST. "il floor non è
    // a 3 per scelta ma per un limite dell'API, il fix vero arriva in questa PR"
    // therefore classifies as by-choice while declaring the opposite — the fixer
    // would silently drop a real 🔴 and exit green.
    expect(
      p,
      `${file}: the prompt no longer warns that a NEGATED state word still classifies as ` +
        'the closing state (earliest-match-wins).',
    ).toMatch(/negazione/i);
    expect(p, `${file}: the prompt no longer requires the motive to come AFTER the state.`)
      .toMatch(/motivo\b[^\n]*\bdopo\b|\bdopo\b[^\n]*\bmotivo\b/i);
  });

  it('pr-redflag-fixer unblocks the loop when the round ends with no diff', () => {
    const p = prompt('pr-redflag-fixer.yml');
    // `pr-review-loop` only fires on workflow_run[tests] with event ==
    // pull_request, i.e. only after a PUSH. A comment-only terminal leaves the
    // 🔴 review as the last one, auto-merge-eval keeps refusing, and nothing
    // collects the PR (recycle-stale-prs only touches `stale-review`).
    expect(
      p,
      'the prompt no longer tells the fixer to push an empty commit when it has nothing ' +
        'to commit — a comment-only terminal deadlocks the PR forever (no re-review, no ' +
        'merge, no recycling).',
    ).toMatch(/git commit --allow-empty/);
    expect(p, 'the prompt no longer explains WHY the push is what re-arms the review.').toMatch(
      /pr-review-loop/,
    );
    expect(p, 'the prompt no longer names auto-merge-eval as the thing that stays blocked.')
      .toMatch(/auto-merge-eval/);
  });

  it('pr-redflag-fixer forbids writing a closing state on an item it is skipping', () => {
    const p = prompt('pr-redflag-fixer.yml');
    // Round 1 writes `per scelta` for a sibling it did not sweep; round 2 reads
    // its own bullet as a settled decision and retires the 🔴 without fixing it.
    // The round cap never arms, because every round declares itself terminal.
    expect(
      p,
      'the prompt no longer forbids the fixer from writing a CLOSING state on work it is ' +
        'merely deferring — at round 2 it would honour its own bullet as a veto.',
    ).toMatch(/non scrivere MAI/i);
  });

  it('issue-fix marks an all-items-skipped aggregate as already-fixed', () => {
    const p = prompt('issue-fix.yml');
    // Without a recognised FIX_OUTCOME the backstop marker is discarded by
    // followup-drainer.mjs, the aggregate re-enters the queue and burns a Claude
    // run per cycle until it ages out; `already-fixed` parks it after one.
    expect(p, 'the `already-fixed` terminal marker is gone from the prompt.').toMatch(
      /FIX_OUTCOME:\s*already-fixed/,
    );
    expect(
      p,
      'the prompt no longer covers the aggregate whose items are ALL skipped — that is ' +
        'the case that retry-loops on quota.',
    ).toMatch(/salti TUTTI/i);
  });

  it('the EMITTER of the 🔴 knows the taxonomy too (pr-review-loop + REVIEW.md)', () => {
    // Teaching only the consumers leaves the loop deadlocked from the other end:
    // the reviewer re-raises the 🔴 on a `per scelta` bullet, the fixer declines
    // with reason, the round cap fires, and `needs-human` lands with the wrong
    // diagnosis ("the fixer cannot do it") on a PR with nothing to fix.
    const reviewer = prompt('pr-review-loop.yml');
    for (const state of ['per scelta', 'by construction', 'blocked: decisione del proprietario']) {
      expect(reviewer, `the reviewer prompt does not name the closing state \`${state}\`.`).toContain(
        state,
      );
    }
    expect(
      reviewer,
      'the reviewer prompt no longer says that a closing state WITH a motive is not a ' +
        'finding — the emitter half of #5917.',
    ).toMatch(/non si emette 🔴/i);
    // The consequence, spelled out where the reviewer reads it: this is what
    // stops the round-cap escalation from landing with the wrong diagnosis.
    expect(
      reviewer,
      'the reviewer prompt no longer cites CLOSING_STATES / the needs-human misdiagnosis, ' +
        'i.e. the substantive rule is gone and only the tier-minimal aside survives.',
    ).toMatch(/CLOSING_STATES[\s\S]*needs-human/);
    // …and the short-path tier must carry it too, or a data/docs-only PR gets
    // the finding the long path would not raise.
    expect(
      reviewer,
      'the tier `minimal` short path no longer exempts a bullet closed with a motive.',
    ).toMatch(/nessun placeholder vuoto[\s\S]{0,400}non è un finding/);

    const reviewDoc = readFileSync(join(ROOT, 'REVIEW.md'), 'utf8');
    expect(
      reviewDoc,
      'REVIEW.md step 2 no longer tells the reviewer that a closing state with a motive is ' +
        'not a finding.',
    ).toMatch(/stato CHIUDENTE/);
  });

  it('the third surface — the local /fix-issue spec — carries the same rule', () => {
    // AGENTS.md #6: the local twin of issue-fix.yml is the same class. A local
    // session that keeps contradicting declared decisions is the same defect
    // with a human in the chair.
    const doc = readFileSync(join(ROOT, 'docs/FIX-ISSUE-COMMAND.md'), 'utf8');
    expect(doc, 'docs/FIX-ISSUE-COMMAND.md does not mention the taxonomy module.').toContain(
      HELPER_MODULE,
    );
    expect(doc, 'docs/FIX-ISSUE-COMMAND.md does not name `sectionBullets`.').toMatch(
      /\bsectionBullets\b/,
    );
    expect(doc, 'docs/FIX-ISSUE-COMMAND.md does not warn about the negated state word.').toMatch(
      /negazione/i,
    );
  });

  it('the helper really exports what the three surfaces name', () => {
    // A prompt that references a renamed helper is an instruction the agent
    // cannot follow, and nothing else in CI would notice.
    for (const fn of ['extractSection', 'sectionBullets', 'stripNonContent', 'bulletState']) {
      expect(typeof (sections as any)[fn], `${fn} is not exported`).toBe('function');
    }
    const re = (sections as any).NON_IMPL_ANCORA_RE;
    expect(re, 'NON_IMPL_ANCORA_RE is not exported').toBeInstanceOf(RegExp);
    // `extractSection` uses `.exec()`: a global regex would carry `lastIndex`
    // between calls and start extracting from the wrong offset.
    expect(re.global, 'NON_IMPL_ANCORA_RE must not be global — extractSection uses .exec()').toBe(
      false,
    );
    expect((sections as any).extractSection('## Non implementato (ancora)\n- x — per scelta\n', re))
      .toMatch(/per scelta/);
  });

  it('the taxonomy behaves as the prompts assume it does', () => {
    // Exhaustive classification of the six states lives in
    // tests/followup-bullet-state-classes.test.ts. Pinned here is only what the
    // NEW prompt text hinges on: the two halves of `blocked:` decide opposite
    // ways, in the module AND in the gate the prompts cite.
    const owner = '- il flag lo decide il proprietario — blocked: decisione del proprietario';
    const technical = '- attende il repo gemello — blocked: il mirror è manuale';
    expect((sections as any).bulletState(owner)).toBe('blocked-owner');
    expect((sections as any).bulletState(technical)).toBe('blocked-technical');
    expect(isCandidateItem(owner), 'blocked-owner must NOT reopen as a follow-up').toBe(false);
    expect(isCandidateItem(technical), 'blocked-technical must stay open work').toBe(true);

    // And the property that makes `sectionBullets` mandatory in the prompts: a
    // fenced example of the taxonomy (both fixers teach the five state words
    // inside a code block) must not be read as a declared state.
    const withFence =
      '- reale — per scelta: il gate lo copre già\n' +
      '```\n- <scope NON fatto> — in questa PR\n```\n';
    expect((sections as any).sectionBullets(withFence)).toEqual([
      '- reale — per scelta: il gate lo copre già',
    ]);
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
