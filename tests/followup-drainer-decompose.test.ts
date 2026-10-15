/**
 * followup-drainer — stadio di decomposizione (2026-08-21).
 *
 * Prima di questo stadio le issue "troppo grandi" uscivano dal ciclo autonomo:
 * `max-turns` al 1° tentativo → `fu-parked`+`needs-human` (assorbente), e i
 * detector epic/backlog parcheggiavano chiedendo a voce uno scorporo che
 * nessuno eseguiva. Questi test coprono le due funzioni pure che governano il
 * nuovo stadio:
 *
 *  - `isDecomposeEligible` — l'anti-ricorsione by-construction: un padre già
 *    decomposto (`decomposed:1`) e una figlia (`from-decompose`) non entrano
 *    MAI nello stadio, così il grafo di decomposizione non può ciclare;
 *  - `decomposedChildNumbers` — il parse del marker `DECOMPOSED_INTO`, l'unico
 *    contratto fra il run planner e il PARENT-CLOSE del drainer: se il parse
 *    sbaglia, un padre viene chiuso con figlie aperte (perdita silenziosa) o
 *    resta aperto per sempre (ratchet).
 */
import { describe, it, expect } from 'vitest';
import {
  isDecomposeEligible,
  decomposedChildNumbers,
  isAgeOutEligible,
  isReparkableCandidate,
} from '../scripts/ci/followup-drainer.mjs';

const iss = (labels: string[], extra: Record<string, unknown> = {}) => ({
  number: 1,
  title: 'follow-up(#100): 5 item deferred — esempio',
  labels: labels.map((name) => ({ name })),
  ...extra,
});

describe('isDecomposeEligible — anti-ricorsione by-construction', () => {
  it('eleggibile: issue queue-managed senza label dello stadio', () => {
    expect(isDecomposeEligible(iss(['follow-up', 'fu-prio:high']))).toBe(true);
  });

  it('NON eleggibile: padre già decomposto (decomposed:1)', () => {
    expect(isDecomposeEligible(iss(['decomposed:1']))).toBe(false);
  });

  it('NON eleggibile: figlia di una decomposizione (from-decompose)', () => {
    expect(isDecomposeEligible(iss(['from-decompose', 'fu-prio:low']))).toBe(false);
  });

  it('NON eleggibile: già in coda o in decomposizione (idempotenza del routing)', () => {
    expect(isDecomposeEligible(iss(['agent:decompose-queued']))).toBe(false);
    expect(isDecomposeEligible(iss(['agent:decompose']))).toBe(false);
  });

  it('needs-human da solo NON esclude (il routing agisce prima del park)', () => {
    expect(isDecomposeEligible(iss(['needs-human']))).toBe(true);
  });

  it('NON eleggibile: già triagiata already-resolved (maybe-resolved, #6275)', () => {
    expect(isDecomposeEligible(iss(['maybe-resolved']))).toBe(false);
  });

  it('NON eleggibile: ri-armo già bruciato (decompose-retried, #7280)', () => {
    // Il park del decompose-rescue lascia esattamente questo set di label e
    // TOGLIE `agent:decompose`: senza l'esclusione la issue parcheggiata
    // tornerebbe eleggibile e il bound «ri-arma UNA volta» sarebbe illimitato.
    expect(isDecomposeEligible(iss(['decompose-retried']))).toBe(false);
    expect(isDecomposeEligible(iss(['fu-parked', 'needs-human', 'decompose-retried']))).toBe(false);
  });

  it('input vuoto/null senza throw', () => {
    expect(isDecomposeEligible({})).toBe(true);
    expect(isDecomposeEligible({ labels: undefined })).toBe(true);
  });
});

describe('decomposedChildNumbers — parse del marker DECOMPOSED_INTO', () => {
  it('estrae i numeri dal marker canonico', () => {
    expect(decomposedChildNumbers([
      { body: 'Scorporata.\n\n<!-- DECOMPOSED_INTO: 6301 6302 6303 -->' },
    ])).toEqual([6301, 6302, 6303]);
  });

  it('accetta la forma con # e virgole (il planner è un LLM: tollera le varianti innocue)', () => {
    expect(decomposedChildNumbers([
      { body: '<!-- DECOMPOSED_INTO: #6301, #6302,#6303 -->' },
    ])).toEqual([6301, 6302, 6303]);
  });

  it("l'ULTIMO marker vince (una decomposizione corretta a mano sovrascrive)", () => {
    expect(decomposedChildNumbers([
      { body: '<!-- DECOMPOSED_INTO: 1 2 -->' },
      { body: 'rifatta meglio\n<!-- DECOMPOSED_INTO: 3 4 5 -->' },
    ])).toEqual([3, 4, 5]);
  });

  it('dedup e ordina', () => {
    expect(decomposedChildNumbers([
      { body: '<!-- DECOMPOSED_INTO: 9 3 9 3 1 -->' },
    ])).toEqual([1, 3, 9]);
  });

  it('[] senza marker, su commenti vuoti, o su marker senza numeri', () => {
    expect(decomposedChildNumbers([])).toEqual([]);
    expect(decomposedChildNumbers([{ body: 'nessun marker qui' }])).toEqual([]);
    expect(decomposedChildNumbers(undefined as never)).toEqual([]);
  });

  it('è case-insensitive e tollera spazi nel marker', () => {
    expect(decomposedChildNumbers([
      { body: '<!--  decomposed_into:  42  -->' },
    ])).toEqual([42]);
  });
});

describe('lo stadio decompose è "in lavorazione" per gli altri pass', () => {
  const old = {
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  };
  const opts = { now: Date.parse('2026-02-01T00:00:00Z'), ageOutDays: 10, inactiveDays: 7 };

  it("age-out NON chiude un'issue in coda decompose, in decomposizione, o un padre in attesa", () => {
    // Baseline: la stessa issue SENZA label decompose è eleggibile all'age-out
    // (guardia contro un test vacuamente verde per un'altra ragione).
    expect(isAgeOutEligible(iss(['follow-up'], old), opts)).toBe(true);
    for (const l of ['agent:decompose-queued', 'agent:decompose', 'decomposed:1']) {
      expect(isAgeOutEligible(iss(['follow-up', l], old), opts)).toBe(false);
    }
  });

  it('parked-retry NON ripesca chi è nello stadio decompose', () => {
    expect(isReparkableCandidate(iss(['follow-up', 'fu-parked']))).toBe(true);
    for (const l of ['agent:decompose-queued', 'agent:decompose', 'decomposed:1']) {
      expect(isReparkableCandidate(iss(['follow-up', 'fu-parked', l]))).toBe(false);
    }
  });
});
