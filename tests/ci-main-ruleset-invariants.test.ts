import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VITEST_CHECK_NAME } from '../scripts/ci/lib/constants.mjs';
import {
  evaluateRulesets,
  rulesetGuardsMain,
  requiredContexts,
} from '../scripts/ci/check-main-ruleset-invariants.mjs';

/**
 * L'invariante sorvegliata sta in una impostazione GitHub, non nel repo: il
 * Ruleset di `main` che rende obbligatorio il check vitest (#6590, follow-up di
 * #6584). Questi test non parlano con l'API — coprono la LOGICA del verdetto,
 * cioè l'unica parte che può sbagliare in silenzio: dire «protetto» su una
 * configurazione che non protegge niente.
 */

const ROOT = resolve(import.meta.dirname, '..');

/** Ruleset che soddisfa l'invariante, nella forma restituita da `GET /rulesets/:id`. */
function guardingRuleset(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'main required CI checks',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules: [
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: VITEST_CHECK_NAME }] },
      },
    ],
    ...overrides,
  };
}

describe('rulesetGuardsMain', () => {
  it('riconosce un ruleset attivo che include refs/heads/main', () => {
    expect(rulesetGuardsMain(guardingRuleset())).toBe(true);
  });

  it('accetta anche ~DEFAULT_BRANCH', () => {
    const rs = guardingRuleset({ conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } } });
    expect(rulesetGuardsMain(rs)).toBe(true);
  });

  it('scarta un ruleset in evaluate/disabled', () => {
    expect(rulesetGuardsMain(guardingRuleset({ enforcement: 'evaluate' }))).toBe(false);
    expect(rulesetGuardsMain(guardingRuleset({ enforcement: 'disabled' }))).toBe(false);
  });

  it('scarta un target diverso da branch', () => {
    expect(rulesetGuardsMain(guardingRuleset({ target: 'tag' }))).toBe(false);
  });

  it('scarta un ruleset che include ~ALL ma esclude main (exclude vince)', () => {
    const rs = guardingRuleset({
      conditions: { ref_name: { include: ['~ALL'], exclude: ['refs/heads/main'] } },
    });
    expect(rulesetGuardsMain(rs)).toBe(false);
  });

  it('scarta un ruleset che protegge solo un altro branch', () => {
    const rs = guardingRuleset({
      conditions: { ref_name: { include: ['refs/heads/release'], exclude: [] } },
    });
    expect(rulesetGuardsMain(rs)).toBe(false);
  });
});

describe('requiredContexts', () => {
  it('raccoglie i context di tutte le regole required_status_checks', () => {
    const rs = guardingRuleset({
      rules: [
        { type: 'pull_request', parameters: {} },
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'lint' }, { context: VITEST_CHECK_NAME }] },
        },
      ],
    });
    expect(requiredContexts(rs)).toEqual(['lint', VITEST_CHECK_NAME]);
  });

  it('restituisce lista vuota su un ruleset senza regole di status check', () => {
    expect(requiredContexts(guardingRuleset({ rules: [] }))).toEqual([]);
  });
});

describe('evaluateRulesets', () => {
  it('ok quando un ruleset attivo su main richiede il check vitest', () => {
    const verdict = evaluateRulesets([guardingRuleset()]);
    expect(verdict.ok).toBe(true);
    expect(verdict.contexts).toContain(VITEST_CHECK_NAME);
  });

  it('violazione quando nessun ruleset attivo protegge main', () => {
    const verdict = evaluateRulesets([guardingRuleset({ enforcement: 'disabled' })]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('no-active-ruleset');
  });

  it('violazione su lista vuota', () => {
    expect(evaluateRulesets([]).reason).toBe('no-active-ruleset');
  });

  it('violazione quando il ruleset esiste ma richiede altri check', () => {
    const rs = guardingRuleset({
      rules: [
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'build' }] },
        },
      ],
    });
    const verdict = evaluateRulesets([rs]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('missing-required-check');
    expect(verdict.message).toContain('build');
  });

  it('il match sul context è byte-per-byte: una variante vicina NON protegge', () => {
    const rs = guardingRuleset({
      rules: [
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'vitest (unit+integration)' }] },
        },
      ],
    });
    expect(evaluateRulesets([rs]).ok).toBe(false);
  });

  it('somma i context di più ruleset che proteggono main', () => {
    const other = guardingRuleset({
      id: 2,
      rules: [
        { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'lint' }] } },
      ],
    });
    const verdict = evaluateRulesets([other, guardingRuleset()]);
    expect(verdict.ok).toBe(true);
    expect(verdict.contexts).toEqual(['lint', VITEST_CHECK_NAME]);
  });
});

describe('monitor workflow', () => {
  const WF = readFileSync(
    resolve(ROOT, '.github/workflows/main-ruleset-invariants-monitor.yml'),
    'utf-8',
  );

  it('gira lo script di verifica', () => {
    expect(WF).toContain('scripts/ci/check-main-ruleset-invariants.mjs');
  });

  it('apre la issue di drift solo sul verdetto 1, mai sull indeterminato 2', () => {
    expect(WF).toContain("steps.verify.outputs.code == '1'");
  });
});
