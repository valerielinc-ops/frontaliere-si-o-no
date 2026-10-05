import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

/**
 * Dove translate-pending usa Codex Luna Max. Due decisioni del proprietario:
 *   · 2026-09-25: «Per il translate pending aggiungi codex ma dopo argos e i
 *     sistemi che non consumano quota» → le fasi 2d/2e tengono Codex in coda
 *     alla cascata (FREE_TRANSLATE_CODEX_TIER=last);
 *   · H7, 2026-10-05: «utilizza codex luna max per le traduzioni quando
 *     falliscono le chiavi» → la cascata 2b riceve il socket con la posizione
 *     di default di free-translate.mjs: Codex entra quando DeepL e Azure non
 *     servono piu' la run (chiavi rifiutate o fuori quota) e prima dei tier
 *     gratuiti. Finche' DeepL risponde, Codex non viene chiamato.
 * Vale per la logica del sito e per l'artifact generato che gira sul pool del
 * corpus:
 *   · il broker parte dopo il passaggio Argos bulk (2a) e prima della 2b;
 *   · il socket arriva solo alle fasi 2b, 2d e 2e, ognuna con un budget per
 *     run esplicito; la 2b senza `last`, la 2d/2e con `last`;
 *   · nessuno step imposta AI_MODELS_PREFER;
 *   · TTL del broker che copre la finestra delle fasi.
 */
type Step = { id?: string; name?: string; uses?: string; if?: string; env?: Record<string, unknown>; with?: Record<string, unknown> };

const TARGETS = [
  '.github/workflows/translate-pending-logic.yml',
  '.github/corpus-workflows/translate-pending.yml',
];
const PHASE_2B = 'Phase 2b: Translate pending jobs (cascade top-up)';
const PHASE_2D = 'Phase 2d: Fix untranslated titles (free cascade)';
const PHASE_2E = 'Phase 2e: Fix untranslated descriptions (free cascade)';

function stepsOf(rel: string): Step[] {
  const workflow = YAML.parse(fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8')) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  return workflow.jobs.translate.steps;
}

function expectBudget(step: Step) {
  const calls = Number(step.env?.FREE_TRANSLATE_CODEX_MAX_CALLS);
  const ms = Number(step.env?.FREE_TRANSLATE_CODEX_MAX_MS);
  expect(calls, step.name).toBeGreaterThan(0);
  expect(calls, step.name).toBeLessThanOrEqual(40);
  expect(ms, step.name).toBeGreaterThan(0);
  expect(ms, step.name).toBeLessThanOrEqual(15 * 60 * 1000);
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

  it('il socket arriva solo alle fasi 2b/2d/2e, ognuna con un budget per run', () => {
    const consumers = steps.filter((step) => step.env
      && Object.prototype.hasOwnProperty.call(step.env, 'CODEX_AUTH_BROKER_SOCKET')
      && step.name !== 'Cleanup Codex auth broker');
    expect(consumers.map((step) => step.name)).toEqual([PHASE_2B, PHASE_2D, PHASE_2E]);
    for (const step of consumers) expectBudget(step);
    expect(steps.some((step) => step.env && Object.prototype.hasOwnProperty.call(step.env, 'AI_MODELS_PREFER'))).toBe(false);
  });

  it('nella 2b Codex e\' la riserva dei tier a chiave, nella 2d/2e l\'ultimo tier', () => {
    const cascade = steps.find((step) => step.name === PHASE_2B);
    // Posizione di default: Codex dopo DeepL e Azure, solo quando sono fuori gioco.
    expect(cascade?.env?.FREE_TRANSLATE_CODEX_TIER).toBeUndefined();
    for (const name of [PHASE_2D, PHASE_2E]) {
      expect(steps.find((step) => step.name === name)?.env?.FREE_TRANSLATE_CODEX_TIER).toBe('last');
    }
  });

  it('le fasi che usano Codex e le statistiche condividono la cartella dei report della riserva', () => {
    const dirs = [PHASE_2B, PHASE_2D, PHASE_2E, 'Log translation stats (after)']
      .map((name) => steps.find((step) => step.name === name)?.env?.TRANSLATE_CODEX_RESERVE_DIR);
    expect(dirs[0]).toBe('${{ runner.temp }}/translation-codex-reserve');
    expect(new Set(dirs).size).toBe(1);
  });
});
