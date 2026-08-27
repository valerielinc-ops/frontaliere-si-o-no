import { describe, expect, it } from 'vitest';

import { remainingCooldownMs } from '../../scripts/ci/pr-watch-gate.mjs';

// Regressione dell'incidente 2026-08-24: senza freno, ogni tentativo di stop
// re-invocava il gate all'istante — zero tempo reale fra un blocco e l'altro,
// decine di round-trip identici in pochi minuti con la coda CI congestionata,
// ognuno con il contesto della sessione re-iniettato dall'harness. Il gate
// ora dorme fino a COOLDOWN_MS dall'ultimo blocco prima di bloccare di nuovo.

describe('remainingCooldownMs', () => {
  it('nessun blocco precedente (lastAt=0) → cooldown pieno', () => {
    expect(remainingCooldownMs(0, 0, 45_000)).toBe(45_000);
  });

  it('appena bloccato → resta quasi tutto il cooldown', () => {
    expect(remainingCooldownMs(1_000, 1_500, 45_000)).toBe(44_500);
  });

  it('cooldown scaduto → 0, nessuna attesa', () => {
    expect(remainingCooldownMs(0, 46_000, 45_000)).toBe(0);
    expect(remainingCooldownMs(0, 45_000, 45_000)).toBe(0);
  });

  it('orologio andato indietro (lastAt nel futuro) → fail-safe, 0', () => {
    expect(remainingCooldownMs(10_000, 1_000, 45_000)).toBe(0);
  });
});
