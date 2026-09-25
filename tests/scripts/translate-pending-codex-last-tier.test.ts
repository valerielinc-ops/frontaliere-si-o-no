import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

/**
 * translate-pending usa Codex Luna Max SOLO dopo Argos e dopo ogni tier che
 * non consuma quota (decisione del proprietario del 2026-09-25: «Per il
 * translate pending aggiungi codex ma dopo argos e i sistemi che non consumano
 * quota»). Vale per la logica del sito e per l'artifact generato che gira sul
 * pool del corpus:
 *   · il broker parte dopo i due passaggi Argos (bulk 2a e mop-up 2c);
 *   · il socket arriva solo alle fasi 2d/2e, con FREE_TRANSLATE_CODEX_TIER=last,
 *     cioe' Codex in coda alla cascata di free-translate.mjs;
 *   · la cascata 2b non riceve il socket e nessuno step imposta AI_MODELS_PREFER;
 *   · budget per run esplicito e TTL del broker che copre la finestra delle fasi.
 */
type Step = { id?: string; name?: string; uses?: string; if?: string; env?: Record<string, unknown>; with?: Record<string, unknown> };

const TARGETS = [
  '.github/workflows/translate-pending-logic.yml',
  '.github/corpus-workflows/translate-pending.yml',
];

function stepsOf(rel: string): Step[] {
  const workflow = YAML.parse(fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8')) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  return workflow.jobs.translate.steps;
}

describe.each(TARGETS)('translate-pending: Codex solo dopo Argos (%s)', (rel) => {
  const steps = stepsOf(rel);
  const at = (predicate: (step: Step) => boolean) => steps.findIndex(predicate);

  it('il broker parte dopo i due passaggi Argos', () => {
    const setupAt = at((step) => step.id === 'setup_claude_haiku_fallback');
    expect(setupAt).toBeGreaterThan(0);
    const argos = [
      at((step) => /^Phase 2a: .*Argos/.test(step.name ?? '')),
      at((step) => /^Phase 2c mop-up: .*Argos/.test(step.name ?? '')),
    ];
    for (const index of argos) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(setupAt);
    }
    const setup = steps[setupAt];
    expect(setup.with?.codex_auth_json).toBe('${{ secrets.CODEX_AUTH_JSON }}');
    // TTL di inattivita' >= finestra di 210 minuti delle fasi 2d/2e.
    expect(Number(setup.with?.broker_idle_ttl_ms)).toBeGreaterThanOrEqual(12_600_000);
  });

  it('il socket arriva solo alle fasi 2d/2e, con Codex in coda alla cascata e un budget', () => {
    const consumers = steps.filter((step) => step.env
      && Object.prototype.hasOwnProperty.call(step.env, 'CODEX_AUTH_BROKER_SOCKET')
      && step.name !== 'Cleanup Codex auth broker');
    expect(consumers.map((step) => step.name)).toEqual([
      'Phase 2d: Fix untranslated titles (free cascade)',
      'Phase 2e: Fix untranslated descriptions (free cascade)',
    ]);
    for (const step of consumers) {
      expect(step.env?.FREE_TRANSLATE_CODEX_TIER).toBe('last');
      const calls = Number(step.env?.FREE_TRANSLATE_CODEX_MAX_CALLS);
      const ms = Number(step.env?.FREE_TRANSLATE_CODEX_MAX_MS);
      expect(calls).toBeGreaterThan(0);
      expect(calls).toBeLessThanOrEqual(40);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(15 * 60 * 1000);
    }
    const cascade = steps.find((step) => /^Phase 2b:/.test(step.name ?? ''));
    expect(cascade).toBeDefined();
    expect(cascade?.env?.CODEX_AUTH_BROKER_SOCKET).toBeUndefined();
    expect(steps.some((step) => step.env && Object.prototype.hasOwnProperty.call(step.env, 'AI_MODELS_PREFER'))).toBe(false);
  });
});
