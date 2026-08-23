/**
 * followup-drainer — la finestra di scansione rotante copre DAVVERO il pool.
 *
 * La rotazione esisteva già (2026-08-21) e la diagnosi era giusta: con un cap
 * fisso e l'ordine stabile di `gh issue list`, le candidate eccedenti sarebbero
 * sempre le stesse, e il «rinviate al prossimo tick» del log sarebbe una bugia.
 * Ma il PASSO era di una posizione per tick, mentre il commento accanto
 * dichiarava copertura «in ⌈pool/cap⌉ tick». Con passo 1 servono fino a
 * `pool - cap` tick: sui numeri del sito del 2026-08-23 (pool 44, cap 25) sono
 * 19 tick (~6,5 ore) invece di 2 (~40 minuti).
 *
 * Non era teoria: misurate 4 candidate sopra il cooldown di 5 giorni, di cui 2
 * non capability-scoped (#4854, e #6017 che è `fu-prio:high`), e ZERO
 * `PARKED-RETRY` negli ultimi 30 run del drainer — con «coda vuota» 11 volte.
 *
 * Questi test fissano l'invariante che il commento dichiarava e il codice non
 * dava: **ogni posizione del pool viene letta almeno una volta entro
 * ⌈pool/cap⌉ tick consecutivi**.
 */
import { describe, it, expect } from 'vitest';
import { scanWindowOffset, rotateForScan } from '../scripts/ci/followup-drainer.mjs';

const PERIOD = 20 * 60_000;
const at = (tick: number) => tick * PERIOD;

/** Le posizioni del pool lette al tick `t`, dato cap e dimensione. */
function windowAt(poolSize: number, scanMax: number, tick: number): number[] {
  const pool = Array.from({ length: poolSize }, (_, i) => i);
  return rotateForScan(pool, { scanMax, now: at(tick), periodMs: PERIOD }).slice(0, scanMax);
}

describe('copertura — l\'invariante che il commento dichiarava', () => {
  it('i numeri reali del sito: pool 44, cap 25 → coperto in 2 tick', () => {
    const visti = new Set([...windowAt(44, 25, 0), ...windowAt(44, 25, 1)]);
    expect(visti.size).toBe(44);
    // Col passo di 1 posizione per tick, gli stessi 2 tick ne vedevano 26.
    // Non è una sfumatura: le candidate ri-accodabili stavano alle posizioni
    // 38-42, cioè fuori da entrambe le finestre.
    expect([...visti].sort((a, b) => a - b)).toEqual(Array.from({ length: 44 }, (_, i) => i));
  });

  it('vale per una griglia di dimensioni, non solo per il caso misurato', () => {
    for (const poolSize of [26, 30, 44, 50, 99, 100, 101, 250]) {
      for (const scanMax of [5, 10, 25, 40]) {
        const tickNecessari = Math.ceil(poolSize / scanMax);
        const visti = new Set<number>();
        for (let t = 0; t < tickNecessari; t++) for (const i of windowAt(poolSize, scanMax, t)) visti.add(i);
        expect(
          visti.size,
          `pool=${poolSize} cap=${scanMax}: coperte ${visti.size}/${poolSize} in ${tickNecessari} tick`,
        ).toBe(poolSize);
      }
    }
  });

  it('nessuna posizione è privilegiata: su un giro completo la copertura è uniforme', () => {
    // Se una posizione venisse letta meno delle altre, la starvation sarebbe
    // solo attenuata invece che chiusa — ed è il modo in cui difetti come
    // questo tornano senza che nessuno se ne accorga.
    const poolSize = 44, scanMax = 25;
    const conteggi = new Array(poolSize).fill(0);
    for (let t = 0; t < poolSize; t++) for (const i of windowAt(poolSize, scanMax, t)) conteggi[i]++;
    expect(Math.min(...conteggi)).toBe(Math.max(...conteggi));
  });
});

describe('scanWindowOffset — casi degeneri (nessuna rotazione da fare)', () => {
  it('pool che sta tutto nel cap → offset 0, ordine di priorità del chiamante intatto', () => {
    // Ruotare qui non cambierebbe CHI viene letto, solo l'ordine — e
    // sacrificherebbe l'ordinamento che il chiamante ha scelto apposta.
    expect(scanWindowOffset(19, { scanMax: 25, now: at(7), periodMs: PERIOD })).toBe(0);
    expect(scanWindowOffset(25, { scanMax: 25, now: at(7), periodMs: PERIOD })).toBe(0);
  });

  it('pool vuoto, cap assente o periodo assente → offset 0, mai un throw', () => {
    expect(scanWindowOffset(0, { scanMax: 25, now: at(3), periodMs: PERIOD })).toBe(0);
    expect(scanWindowOffset(44, { scanMax: 0, now: at(3), periodMs: PERIOD })).toBe(0);
    expect(scanWindowOffset(44, { scanMax: 25, now: at(3), periodMs: 0 })).toBe(0);
    expect(scanWindowOffset(44, { scanMax: 25, now: Number.NaN, periodMs: PERIOD })).toBe(0);
  });

  it('l\'offset resta sempre dentro [0, poolSize)', () => {
    for (let t = 0; t < 200; t++) {
      const off = scanWindowOffset(44, { scanMax: 25, now: at(t), periodMs: PERIOD });
      expect(off).toBeGreaterThanOrEqual(0);
      expect(off).toBeLessThan(44);
    }
  });
});

describe('rotateForScan — non perde né duplica candidate', () => {
  it('è una permutazione del pool, a ogni tick', () => {
    const pool = Array.from({ length: 44 }, (_, i) => `#${i}`);
    for (let t = 0; t < 10; t++) {
      const r = rotateForScan(pool, { scanMax: 25, now: at(t), periodMs: PERIOD });
      expect(r).toHaveLength(pool.length);
      expect([...r].sort()).toEqual([...pool].sort());
    }
  });

  it('run diverse nello STESSO bucket di 20 minuti leggono la stessa fetta', () => {
    // Voluto: le run extra da `workflow_run` non devono sfogliare il pool senza
    // che passi tempo vero, altrimenti una raffica di fine-fix brucia il giro.
    const pool = Array.from({ length: 44 }, (_, i) => i);
    const a = rotateForScan(pool, { scanMax: 25, now: at(3), periodMs: PERIOD });
    const b = rotateForScan(pool, { scanMax: 25, now: at(3) + 19 * 60_000, periodMs: PERIOD });
    expect(b).toEqual(a);
  });

  it('input non-array → array vuoto, mai un throw', () => {
    expect(rotateForScan(null as never, { scanMax: 25, now: at(1), periodMs: PERIOD })).toEqual([]);
  });
});
