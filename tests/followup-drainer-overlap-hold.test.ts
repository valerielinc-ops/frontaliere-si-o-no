/**
 * Un `overlap-skip` del fixer non è un tentativo fallito.
 *
 * #10586/#10587 («riapplicare la PR #10569») sono arrivate a `fu-attempt:3` e
 * `fu-parked` in tre ore: il fixer rinviava per `tests/data-refresh-pr-wiring.test.ts`
 * «in volo» in #10555, il pre-flight del drainer non vedeva quel path (fuori da
 * CODE_PATH_RE), ri-promuoveva, e il rescue contava ogni rinvio come run morta.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  overlapBlockerActive,
  overlapSkipBlocker,
} from '../scripts/ci/followup-drainer.mjs';

const comment = (body: string, createdAt: string) => ({ body, createdAt, author: { login: 'frontaliere-automation' } });

describe('overlapSkipBlocker: la PR nominata dall\'ultimo verdetto del fixer', () => {
  it('legge la PR dal commento overlap-skip più recente', () => {
    expect(overlapSkipBlocker([
      comment('File `tests/data-refresh-pr-wiring.test.ts` già in volo nella PR #10555 (fix(ci): gate) — skip.\n<!-- FIX_OUTCOME: overlap-skip -->', '2026-09-30T16:56:00Z'),
      comment('File `x` già in volo nella PR #10596 (fix) — skip.\n<!-- FIX_OUTCOME: overlap-skip -->', '2026-09-30T18:35:00Z'),
    ])).toBe(10596);
  });

  it('in un hand-off preferisce la PR «in volo» alla PR da riapplicare citata prima', () => {
    expect(overlapSkipBlocker([
      comment('Riapplicare la PR #10569: file `t.ts` già in volo nella PR #10555 — skip\n<!-- FIX_OUTCOME: overlap-skip -->', '2026-09-30T16:00:00Z'),
    ])).toBe(10555);
  });

  it('regge il commento malformato senza nome file (backtick eseguiti dalla shell)', () => {
    expect(overlapSkipBlocker([
      comment('File  già in volo nella PR #10555 (fix(ci): gate scheduled data refreshes) — skip\n<!-- FIX_OUTCOME: overlap-skip -->', '2026-09-30T15:52:04Z'),
    ])).toBe(10555);
  });

  it.each([
    ['un verdetto più recente diverso', [
      comment('File `a` già in volo nella PR #10555 — skip\n<!-- FIX_OUTCOME: overlap-skip -->', '2026-09-30T15:00:00Z'),
      comment('<!-- FIX_OUTCOME: max-turns -->', '2026-09-30T16:00:00Z'),
    ]],
    ['nessun verdetto', [comment('nota qualsiasi su PR #10555', '2026-09-30T15:00:00Z')]],
    ['overlap-skip senza PR nominata', [comment('skip per overlap\n<!-- FIX_OUTCOME: overlap-skip -->', '2026-09-30T15:00:00Z')]],
    ['commenti assenti', []],
  ])('null con %s', (_label, comments) => {
    expect(overlapSkipBlocker(comments)).toBeNull();
  });

  it('accetta anche la forma REST (created_at)', () => {
    expect(overlapSkipBlocker([
      { body: 'già in volo nella PR #10555\n<!-- FIX_OUTCOME: overlap-skip -->', created_at: '2026-09-30T15:00:00Z' },
    ])).toBe(10555);
  });
});

describe('overlapBlockerActive: solo una PR aperta e non ferma trattiene la issue', () => {
  it.each([
    [{ state: 'OPEN', labels: [] }, true],
    [{ state: 'OPEN', labels: [{ name: 'collision-risk' }, { name: 'agent:autofix' }] }, true],
    [{ state: 'OPEN', labels: [{ name: 'has-conflicts' }] }, false],
    [{ state: 'OPEN', labels: [{ name: 'stale-review' }] }, false],
    [{ state: 'OPEN', labels: [{ name: 'needs-human' }] }, false],
    [{ state: 'MERGED', labels: [] }, false],
    [{ state: 'CLOSED', labels: [] }, false],
    [null, false],
  ])('%j → %s', (pr, expected) => {
    expect(overlapBlockerActive(pr)).toBe(expected);
  });
});

describe('prompt di issue-fix: commenti senza sostituzione di comando', () => {
  it('i commenti del fixer passano da --body-file con heredoc quotato', () => {
    // I commenti overlap-skip di #10586/#10587 avevano il nome file vuoto
    // («File  già in volo…») e in #10383 lo SHA di un `git merge-tree`
    // eseguito: i backtick dentro `--body "..."` sono sostituzione di comando.
    const workflow = readFileSync('.github/workflows/issue-fix.yml', 'utf8');
    const rule = workflow.slice(workflow.indexOf('**Telemetria outcome (OBBLIGATORIO):**'));
    const line = rule.slice(0, rule.indexOf('\n'));
    expect(line).toContain("Commenti sempre con `--body-file` da heredoc `<<'EOF'`");
  });
});

describe('wiring nel drainer', () => {
  const source = readFileSync('scripts/ci/followup-drainer.mjs', 'utf8');

  it('il rescue ri-accoda un overlap-skip su PR attiva senza fu-attempt, prima dei rami che lo consumano', () => {
    const branch = source.indexOf("if (outcome === 'overlap-skip') {");
    const nonRetryable = source.indexOf('if (outcome && NON_RETRYABLE.has(outcome)) {', branch);
    const ageAttempts = source.indexOf('// rescue/park per età-tentativi', branch);
    expect(branch).toBeGreaterThan(-1);
    expect(nonRetryable).toBeGreaterThan(branch);
    expect(ageAttempts).toBeGreaterThan(branch);
    const body = source.slice(branch, nonRetryable);
    expect(body).toContain('overlapBlockerActive(readOverlapBlocker(blocker))');
    expect(body).toContain('edit(iss.number, { add: [LBL_QUEUED], remove: [LBL_FIX] });');
    expect(body).not.toContain('fu-attempt');
  });

  it('il drain trattiene un candidato sulla PR dichiarata, subito prima del pre-flight dei path', () => {
    const drain = source.slice(source.indexOf('for (const cand of queued) {'));
    const fetch = drain.indexOf("'--json', 'body'");
    const hold = drain.indexOf('const declaredBlocker = overlapSkipBlocker(issueComments(cand.number) || []);');
    const pathOverlap = drain.indexOf('const candPaths = extractCodePaths(');
    expect(fetch).toBeGreaterThan(-1);
    expect(hold).toBeGreaterThan(fetch);
    expect(pathOverlap).toBeGreaterThan(hold);
    expect(drain.slice(hold, pathOverlap)).toContain('overlapBlockerActive(readOverlapBlocker(declaredBlocker))');
  });
});
