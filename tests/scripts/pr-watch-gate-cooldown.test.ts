import { describe, expect, it } from 'vitest';

import { enforcesInThisEnvironment, remainingCooldownMs } from '../../scripts/ci/pr-watch-gate.mjs';

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

// Il gate blocca una SESSIONE che può tornare a leggere la review. Dentro
// `issue-fix.yml` non c'è nessuno che torna: il run ha un budget di turni
// finito e la PR è già seguita da pr-review-loop / pr-redflag-fixer /
// pr-autorebase. Misurato il 2026-09-05: Stop hook feedback in 21 run su 26,
// 34% dei tool call dopo il primo `gh pr create`, 15 run su 29 morte al valore
// esatto del cap. Il corpus, senza questi hook e con cap più bassi, sta al 6%.
describe('enforcesInThisEnvironment', () => {
  it('sessione normale (niente GITHUB_ACTIONS) → il gate blocca', () => {
    expect(enforcesInThisEnvironment({})).toBe(true);
  });

  it('run di GitHub Actions → il gate si sfila', () => {
    expect(enforcesInThisEnvironment({ GITHUB_ACTIONS: 'true' })).toBe(false);
  });

  it('solo il valore letterale `true` disarma il gate', () => {
    // GitHub scrive esattamente 'true'. Qualunque altra cosa (una variabile
    // lasciata a '', un 'false' di un runner locale tipo `act`) deve lasciare
    // il gate attivo: il default sicuro qui è bloccare.
    expect(enforcesInThisEnvironment({ GITHUB_ACTIONS: 'false' })).toBe(true);
    expect(enforcesInThisEnvironment({ GITHUB_ACTIONS: '' })).toBe(true);
    expect(enforcesInThisEnvironment({ GITHUB_ACTIONS: '1' })).toBe(true);
  });
});
