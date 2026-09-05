/**
 * followup-drainer — `parent-close` non può tornare a scansionare sempre la
 * stessa testa della lista.
 *
 * Il cap di `parent-close` conta le ESAMINATE, non le azioni: l'esame è il
 * costo (1 view commenti + K view di stato per padre), quindi contare le
 * esaminate è giusto. Ma `gh issue list` ordina dalla più recente, e senza
 * rotazione le 5 posizioni di testa sono le stesse a ogni tick — e sono per
 * costruzione i padri appena decomposti, quelli con le figlie ancora aperte.
 * Il «rinviati al prossimo tick» del log diventa allora una bugia: il tick
 * dopo riesamina gli stessi cinque, per sempre.
 *
 * Misurato il 2026-09-05 sul sito prima della fix: 39 padri `decomposed:1`,
 * il contatore «N padri rinviati» fermo a 33-34 per ~25 run consecutive e
 * ZERO `PARENT-CLOSE` in 40 run. Otto padri avevano TUTTE le figlie chiuse —
 * chiudibili all'istante — e nessuno era nella testa da 5: posizioni 20, 22,
 * 23, 27, 29, 31, 33 e 36, aperti da 11-23 giorni. Non erano difficili:
 * erano irraggiungibili.
 *
 * L'invariante fissata qui è quella che gli altri stadi scansionati hanno già:
 * **ogni posizione del pool è esaminata almeno una volta entro ⌈pool/cap⌉ tick
 * consecutivi**, a costo per run invariato.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rotateForScan } from '../scripts/ci/followup-drainer.mjs';

const PERIOD = 20 * 60_000;
const CAP = 5; // PARENT_CLOSE_MAX_PER_RUN di default

/** Le posizioni del pool esaminate al tick `t`. */
function examinedAt(poolSize: number, tick: number, scanMax = CAP): number[] {
  const pool = Array.from({ length: poolSize }, (_, i) => i);
  return rotateForScan(pool, { scanMax, now: tick * PERIOD, periodMs: PERIOD }).slice(0, scanMax);
}

describe('parent-close — la testa della lista non monopolizza il cap', () => {
  it('i numeri misurati il 05-09 (39 padri, cap 5): pool coperto in 8 tick', () => {
    const visti = new Set<number>();
    for (let t = 0; t < Math.ceil(39 / CAP); t++) for (const i of examinedAt(39, t)) visti.add(i);
    expect(visti.size).toBe(39);
  });

  it('raggiunge le 8 posizioni che erano chiudibili e mai esaminate', () => {
    // Senza rotazione queste otto — TUTTE le figlie chiuse, aperte da 11-23
    // giorni — non entravano in nessuna finestra: la testa da 5 le precedeva
    // sempre. È la prova che il difetto costava chiusure vere, non solo run.
    const chiudibili = [20, 22, 23, 27, 29, 31, 33, 36];
    const visti = new Set<number>();
    for (let t = 0; t < Math.ceil(39 / CAP); t++) for (const i of examinedAt(39, t)) visti.add(i);
    for (const pos of chiudibili) expect(visti.has(pos), `posizione ${pos} mai esaminata`).toBe(true);
  });

  it('vale su una griglia di dimensioni, non solo sul caso misurato', () => {
    for (const poolSize of [6, 11, 39, 40, 41, 120]) {
      const visti = new Set<number>();
      for (let t = 0; t < Math.ceil(poolSize / CAP); t++) for (const i of examinedAt(poolSize, t)) visti.add(i);
      expect(visti.size, `pool=${poolSize}: coperte ${visti.size}/${poolSize}`).toBe(poolSize);
    }
  });

  it('il costo per run non cambia: sempre e solo `cap` esaminate', () => {
    for (let t = 0; t < 12; t++) expect(examinedAt(39, t).length).toBe(CAP);
  });
});

describe('il sorgente non può tornare a iterare la lista non ruotata', () => {
  // Pin sul sorgente, non sul comportamento: l'invariante sopra resterebbe
  // verde anche se qualcuno rimettesse `for (const p of parents)`, perché
  // testa `rotateForScan` in isolamento. È quel `for` la riga che ha prodotto
  // il difetto, quindi è quella riga che va sorvegliata.
  const src = readFileSync(
    fileURLToPath(new URL('../scripts/ci/followup-drainer.mjs', import.meta.url)),
    'utf8',
  );

  it('`parent-close` ruota il pool prima di applicare il cap', () => {
    expect(src).toMatch(/rotateForScan\(\s*parents\s*,\s*\{\s*scanMax:\s*PARENT_CLOSE_MAX_PER_RUN/);
  });

  it('il ciclo capped di parent-close itera il pool RUOTATO', () => {
    expect(src).toContain('for (const p of rotatedParents)');
    expect(src).not.toMatch(/for \(const p of parents\) \{[\s\S]{0,200}PARENT_CLOSE_MAX_PER_RUN/);
  });
});
