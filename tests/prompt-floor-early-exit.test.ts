/**
 * Osservatore dell'uscita anticipata quando il budget dettato dalla flotta
 * sta sotto il pavimento dell'impalcatura (corpus #452 / follow-up #511).
 *
 * La DECISIONE vive in `scripts/lib/exhaustion-disposition.mjs` (mode:
 * identical, portata byte-a-byte dal corpus). Questo file la ESEGUE davvero.
 * Il cablaggio in `create-article.mjs` si legge come testo: quel file non e'
 * importabile da un test.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  PROMPT_SCAFFOLD_FLOOR_TOKENS,
  EXIT_ROSTER_CANNOT_SERVE_PROMPT,
  EXIT_NO_ARTICLE_DECLARED,
  isBudgetBelowScaffoldFloor,
  isPromptFloorIrreducible,
  promptFloorSummary,
  isInputCapDeferralVeto,
  isLegitimateQuotaDeferral,
} from '../scripts/lib/exhaustion-disposition.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.resolve(HERE, '../scripts/create-article.mjs'), 'utf-8');

describe('isBudgetBelowScaffoldFloor — predicato shipped', () => {
  it('il pavimento e un numero solo, e vale 5850', () => {
    expect(PROMPT_SCAFFOLD_FLOOR_TOKENS).toBe(5850);
  });

  it('il confine e stretto, e «nessun budget» non e «budget impossibile»', () => {
    expect(isBudgetBelowScaffoldFloor(3000)).toBe(true);
    expect(isBudgetBelowScaffoldFloor(4000)).toBe(true);
    expect(isBudgetBelowScaffoldFloor(PROMPT_SCAFFOLD_FLOOR_TOKENS - 1)).toBe(true);
    expect(isBudgetBelowScaffoldFloor(PROMPT_SCAFFOLD_FLOOR_TOKENS)).toBe(false);
    expect(isBudgetBelowScaffoldFloor(8000)).toBe(false);
    for (const nulla of [0, -1, undefined, null, NaN, '', 'boh', {}]) {
      expect(isBudgetBelowScaffoldFloor(nulla), `${String(nulla)} non e un budget impossibile`).toBe(false);
    }
  });
});

function earlyExitError({
  budget = 4000,
  attempt = 2,
  maxAttempts = 6,
  transient = 90,
  persistent = 10,
}: {
  budget?: number;
  attempt?: number;
  maxAttempts?: number;
  transient?: number;
  persistent?: number;
} = {}) {
  const err: any = new Error('All AI models failed. Chain: [...]. Errors: ...');
  err.code = 'ALL_MODELS_EXHAUSTED';
  err.retryRequestTokenBudget = budget;
  err.exhaustionBreakdown = { transient, persistent, total: transient + persistent };
  err.inputCapReport = {
    count: 4,
    maxSkippedReqLimit: budget,
    minSkippedReqLimit: 3000,
    estimatedRequestTokens: 9740,
  };
  err.promptFloorReport = {
    budget,
    floor: PROMPT_SCAFFOLD_FLOOR_TOKENS,
    attempt,
    maxAttempts,
    section: 'frontaliere',
  };
  return err;
}

describe('isPromptFloorIrreducible — predicato shipped', () => {
  it('un errore marcato dall uscita anticipata e irriducibile', () => {
    const err = earlyExitError();
    expect(isPromptFloorIrreducible(err)).toBe(true);
    expect(promptFloorSummary(err)).toEqual({
      budget: 4000,
      floor: 5850,
      short: 1850,
      attempt: 2,
      maxAttempts: 6,
      attemptsSkipped: 4,
      section: 'frontaliere',
    });
  });

  it('con quota dominante gli altri due predicati direbbero «differisci»', () => {
    const err = earlyExitError({ transient: 90, persistent: 10 });
    expect(isInputCapDeferralVeto(err)).toBe(false);
    expect(isLegitimateQuotaDeferral(err)).toBe(true);
    expect(isPromptFloorIrreducible(err)).toBe(true);
    expect(EXIT_ROSTER_CANNOT_SERVE_PROMPT).not.toBe(EXIT_NO_ARTICLE_DECLARED);
  });

  it('senza marcatura, o senza cascata svuotata, il predicato non afferma niente', () => {
    expect(isPromptFloorIrreducible(null)).toBe(false);
    expect(isPromptFloorIrreducible(new Error('boom'))).toBe(false);
    expect(isPromptFloorIrreducible(earlyExitError({ budget: 8000 }))).toBe(false);
    const altro = earlyExitError();
    altro.code = 'SOMETHING_ELSE';
    expect(isPromptFloorIrreducible(altro)).toBe(false);
    const nonMarcato = earlyExitError();
    delete nonMarcato.promptFloorReport;
    expect(isPromptFloorIrreducible(nonMarcato)).toBe(false);
  });
});

describe('cablaggio in create-article.mjs', () => {
  it('il pavimento NON e riscritto a mano', () => {
    expect(SRC).not.toMatch(/PROMPT_SCAFFOLD_FLOOR_TOKENS\s*=\s*\d+/);
    expect(SRC).toMatch(/PROMPT_SCAFFOLD_FLOOR_TOKENS,/);
  });

  it('l uscita anticipata precede il continue del ciclo di retry', () => {
    const uscita = SRC.indexOf('if (isBudgetBelowScaffoldFloor(lastPromptTokenBudget))');
    const continua = SRC.indexOf('if (attempt < maxAttempts) continue;');
    expect(uscita).toBeGreaterThan(0);
    expect(continua).toBeGreaterThan(0);
    expect(uscita).toBeLessThan(continua);
    const blocco = SRC.slice(uscita, continua);
    expect(blocco).toMatch(/e\.promptFloorReport = \{/);
    expect(blocco).toMatch(/throw e;/);
  });

  it('il ramo di primo livello viene PRIMA degli altri due, ed esce con la costante', () => {
    const floor = SRC.indexOf('if (isPromptFloorIrreducible(e))');
    const veto = SRC.indexOf('if (isInputCapDeferralVeto(e))');
    const defer = SRC.indexOf('if (isQuotaExhaustedError(e))');
    expect(floor).toBeGreaterThan(0);
    expect(veto).toBeGreaterThan(0);
    expect(defer).toBeGreaterThan(0);
    expect(floor).toBeLessThan(veto);
    expect(floor).toBeLessThan(defer);
    const blocco = SRC.slice(floor, veto);
    expect(blocco).toMatch(/process\.exit\(EXIT_ROSTER_CANNOT_SERVE_PROMPT\)/);
  });
});
