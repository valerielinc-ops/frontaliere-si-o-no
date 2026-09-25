/**
 * Translation-infrastructure gate — `isTranslationInfraDown`
 * (issues #2536 Klinik Gut, #2570 ALTEN).
 *
 * The dedicated-crawler localization guard defers untranslated descriptions to
 * translate-pending.yml (instead of hard-failing the run and discarding a
 * successfully-crawled job) ONLY when the translation INFRASTRUCTURE is down —
 * not when a single job merely happens to be untranslated.
 *
 * Before this fix the gate inspected only the LLM model pool (ai-models.mjs).
 * When every Azure key 401'd and the free tiers were off/empty, the LLM pool
 * reported "0 exhausted" (it was never the bottleneck), so the free-translate
 * cascade dying went undetected and the crawler hard-failed. The gate now ORs
 * in the cascade signal: exercised this run (`calls > 0`) but zero successes ⇒
 * every translation provider is down.
 */

import { describe, expect, it } from 'vitest';
import { isTranslationInfraDown } from '../scripts/lib/dedicated-crawler-common.mjs';

describe('isTranslationInfraDown — translation infrastructure detection', () => {
  it('healthy: LLM available + cascade producing successes → NOT down', () => {
    const r = isTranslationInfraDown({
      aiModelsLoaded: true,
      aiModelsAvailable: true,
      aiExhaustedCount: 0,
      cascade: { calls: 12, successes: 12 },
    });
    expect(r).toEqual({ llmDown: false, cascadeDown: false, infraDown: false });
  });

  it('cascade exhausted (calls>0, 0 successes) while LLM "available" → down via cascade (the #2536/#2570 case)', () => {
    const r = isTranslationInfraDown({
      aiModelsLoaded: true,
      aiModelsAvailable: true,
      aiExhaustedCount: 0, // LLM pool reports healthy — it was never the bottleneck
      cascade: { calls: 8, successes: 0 }, // Azure 401 + free tiers off → every call failed
    });
    expect(r.cascadeDown).toBe(true);
    expect(r.llmDown).toBe(false);
    expect(r.infraDown).toBe(true);
  });

  it('LLM pool unavailable → down via LLM (legacy behaviour preserved)', () => {
    const r = isTranslationInfraDown({
      aiModelsLoaded: true,
      aiModelsAvailable: false,
      aiExhaustedCount: 0,
      cascade: { calls: 5, successes: 5 },
    });
    expect(r.llmDown).toBe(true);
    expect(r.infraDown).toBe(true);
  });

  it('LLM pool ≥3 models exhausted → down via LLM (legacy behaviour preserved)', () => {
    const r = isTranslationInfraDown({
      aiModelsLoaded: true,
      aiModelsAvailable: true,
      aiExhaustedCount: 3,
      cascade: { calls: 5, successes: 5 },
    });
    expect(r.llmDown).toBe(true);
    expect(r.infraDown).toBe(true);
  });

  it('cascade with successes>0 (partially working) → NOT down: genuine per-job gaps stay subject to base tolerance', () => {
    const r = isTranslationInfraDown({
      aiModelsLoaded: true,
      aiModelsAvailable: true,
      aiExhaustedCount: 1, // below the ≥3 threshold
      cascade: { calls: 20, successes: 4 },
    });
    expect(r.infraDown).toBe(false);
  });

  it('cascade never exercised (calls=0) → NOT cascade-down (avoids false defer before any translate call)', () => {
    const r = isTranslationInfraDown({
      aiModelsLoaded: true,
      aiModelsAvailable: true,
      aiExhaustedCount: 0,
      cascade: { calls: 0, successes: 0 },
    });
    expect(r.cascadeDown).toBe(false);
    expect(r.infraDown).toBe(false);
  });

  it('ai-models not loaded but cascade exhausted → still down via cascade', () => {
    const r = isTranslationInfraDown({
      aiModelsLoaded: false,
      aiModelsAvailable: null,
      aiExhaustedCount: 0,
      cascade: { calls: 6, successes: 0 },
    });
    expect(r.llmDown).toBe(false);
    expect(r.cascadeDown).toBe(true);
    expect(r.infraDown).toBe(true);
  });

  it('masking: titles translate but every description rejected → down via per-field-type split (#2590)', () => {
    // Cumulative successes>0 (the titles), so the aggregate check alone would
    // say NOT down and leave description-only gaps on the base tolerance.
    const r = isTranslationInfraDown({
      aiModelsLoaded: true,
      aiModelsAvailable: true,
      aiExhaustedCount: 0,
      cascade: {
        calls: 30,
        successes: 15, // all from the short titles
        byFieldType: {
          title: { calls: 15, successes: 15 },
          description: { calls: 15, successes: 0 }, // every long description rejected
        },
      },
    });
    expect(r.cascadeDown).toBe(true);
    expect(r.infraDown).toBe(true);
  });

  it('per-field-type all healthy → NOT down (titles and descriptions both translating)', () => {
    const r = isTranslationInfraDown({
      aiModelsLoaded: true,
      aiModelsAvailable: true,
      aiExhaustedCount: 0,
      cascade: {
        calls: 20,
        successes: 18,
        byFieldType: {
          title: { calls: 10, successes: 10 },
          description: { calls: 10, successes: 8 }, // a couple genuine per-job gaps
        },
      },
    });
    expect(r.cascadeDown).toBe(false);
    expect(r.infraDown).toBe(false);
  });

  it('per-field-type: a field never exercised (calls=0) does not trigger a false defer', () => {
    const r = isTranslationInfraDown({
      aiModelsLoaded: true,
      aiModelsAvailable: true,
      aiExhaustedCount: 0,
      cascade: {
        calls: 10,
        successes: 10,
        byFieldType: {
          title: { calls: 10, successes: 10 },
          description: { calls: 0, successes: 0 }, // no descriptions needed translating
        },
      },
    });
    expect(r.cascadeDown).toBe(false);
    expect(r.infraDown).toBe(false);
  });

  it('missing/null inputs → safe default (not down)', () => {
    expect(isTranslationInfraDown({}).infraDown).toBe(false);
    expect(isTranslationInfraDown().infraDown).toBe(false);
    expect(isTranslationInfraDown({ aiModelsLoaded: true, cascade: null }).infraDown).toBe(false);
  });
});
