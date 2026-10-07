import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

/**
 * Dove translate-pending usa Codex Luna Max. Decisione del proprietario
 * 2026-10-06: la corsia Codex è primaria in tutte le fasi; DeepL, Azure e i
 * sistemi gratuiti restano ripieghi nell'ordine storico. `last` resta solo un
 * override legacy esplicito e nessun workflow di produzione lo imposta.
 * Vale per la logica del sito e per l'artifact generato che gira sul pool del
 * corpus:
 *   · il broker parte dopo il passaggio Argos bulk (2a) e prima della 2b;
 *   · il socket arriva alle fasi 2a.2, 2b, 2d e 2e, ognuna con un budget per
 *     run ereditato dal resolver comune;
 *   · nessuno step imposta AI_MODELS_PREFER;
 *   · TTL del broker che copre la finestra delle fasi.
 */
type Step = { id?: string; name?: string; uses?: string; if?: string; env?: Record<string, unknown>; with?: Record<string, unknown>; run?: string };

const TARGETS = [
  '.github/workflows/translate-pending-logic.yml',
  '.github/corpus-workflows/translate-pending.yml',
];
const PHASE_2A2 = 'Phase 2a.2: Fix untranslated titles (free cascade, before descriptions)';
const PHASE_2B = 'Phase 2b: Translate pending jobs (cascade top-up)';
const PHASE_2D = 'Phase 2d: Fix untranslated titles (free cascade)';
const PHASE_2E = 'Phase 2e: Fix untranslated descriptions (free cascade)';
const CODEX_BUDGET_RESOLVER = 'Resolve Codex reserve budget';
const CODEX_MAX_CALLS_REPO_EXPR = '${{ vars.FREE_TRANSLATE_CODEX_MAX_CALLS }}';
const DEFAULT_CODEX_MAX_CALLS = 350;

function stepsOf(rel: string): Step[] {
  const workflow = YAML.parse(fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8')) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  return workflow.jobs.translate.steps;
}

function effectiveMaxCalls({ inherited = '', repo = '' }: { inherited?: string; repo?: string } = {}) {
  return Number(inherited || repo || String(DEFAULT_CODEX_MAX_CALLS));
}

function expectBudget(step: Step) {
  expect(step.env?.FREE_TRANSLATE_CODEX_MAX_CALLS, step.name).toBeUndefined();
  const calls = effectiveMaxCalls();
  const ms = Number(step.env?.FREE_TRANSLATE_CODEX_MAX_MS);
  expect(calls, step.name).toBe(DEFAULT_CODEX_MAX_CALLS);
  // Decisione del proprietario del 2026-10-06 («alza le chiamate»): 350 per
  // fase. La variabile di repository resta il rollback immediato.
  expect(calls, step.name).toBeLessThanOrEqual(350);
  expect(ms, step.name).toBeGreaterThan(0);
  // La 2b ha una finestra di 30 minuti e puo' spenderne 25; le corsie di
  // riparazione restano a 15: la 2d/2e partono con almeno 15 minuti residui
  // (gate), la 2a.2 ne lascia 10 dei suoi 25 agli altri tier.
  const maxMs = step.name === PHASE_2B ? 25 * 60 * 1000 : 15 * 60 * 1000;
  expect(ms, step.name).toBeLessThanOrEqual(maxMs);
}

describe.each(TARGETS)('translate-pending: dove entra Codex (%s)', (rel) => {
  const steps = stepsOf(rel);
  const at = (predicate: (step: Step) => boolean) => steps.findIndex(predicate);

  it('il broker parte dopo il passaggio Argos bulk e prima della cascata 2b', () => {
    const setupAt = at((step) => step.id === 'setup_claude_haiku_fallback');
    expect(setupAt).toBeGreaterThan(0);
    const argosBulkAt = at((step) => /^Phase 2a: .*Argos/.test(step.name ?? ''));
    expect(argosBulkAt).toBeGreaterThanOrEqual(0);
    expect(argosBulkAt).toBeLessThan(setupAt);
    expect(setupAt).toBeLessThan(at((step) => step.name === PHASE_2B));
    const setup = steps[setupAt];
    expect(setup.if).toContain('inputs.dry_run != true');
    expect(setup.with?.codex_auth_json).toBe('${{ secrets.CODEX_AUTH_JSON }}');
    // TTL di inattivita' >= finestra di 210 minuti delle fasi 2b-2e.
    expect(Number(setup.with?.broker_idle_ttl_ms)).toBeGreaterThanOrEqual(12_600_000);
  });

  it('il socket arriva alle fasi titolo e articolo, che ereditano il budget per run', () => {
    const consumers = steps.filter((step) => step.env
      && Object.prototype.hasOwnProperty.call(step.env, 'CODEX_AUTH_BROKER_SOCKET')
      && step.name !== 'Cleanup Codex auth broker');
    expect(consumers.map((step) => step.name)).toEqual([PHASE_2A2, PHASE_2B, PHASE_2D, PHASE_2E]);
    const resolver = steps.find((step) => step.name === CODEX_BUDGET_RESOLVER);
    expect(resolver?.env?.FREE_TRANSLATE_CODEX_MAX_CALLS_REPO).toBe(CODEX_MAX_CALLS_REPO_EXPR);
    expect(resolver?.run).toContain('FREE_TRANSLATE_CODEX_MAX_CALLS');
    expect(steps.indexOf(resolver!)).toBeLessThan(steps.indexOf(consumers[0]));
    expect(effectiveMaxCalls({ repo: '0' })).toBe(0);
    for (const step of consumers) expectBudget(step);
    for (const step of consumers) expect(step.env?.FREE_TRANSLATE_CODEX_CALL_TIMEOUT_MS, step.name).toBe('480000');
    expect(steps.some((step) => step.env && Object.prototype.hasOwnProperty.call(step.env, 'AI_MODELS_PREFER'))).toBe(false);
  });

  it('tutte le fasi usano il default Codex-primary senza override legacy', () => {
    for (const name of [PHASE_2A2, PHASE_2B, PHASE_2D, PHASE_2E]) {
      expect(steps.find((step) => step.name === name)?.env?.FREE_TRANSLATE_CODEX_TIER).toBeUndefined();
    }
  });

  it('le fasi che usano Codex e le statistiche condividono la cartella dei report della riserva', () => {
    const dirs = [PHASE_2A2, PHASE_2B, PHASE_2D, PHASE_2E, 'Log translation stats (after)']
      .map((name) => steps.find((step) => step.name === name)?.env?.TRANSLATE_CODEX_RESERVE_DIR);
    expect(dirs[0]).toBe('${{ runner.temp }}/translation-codex-reserve');
    expect(new Set(dirs).size).toBe(1);
  });
});
