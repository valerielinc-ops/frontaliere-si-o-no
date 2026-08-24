/**
 * harvest-agent-lessons — l'annotazione del lavoro orfano dei `max-turns`.
 *
 * Il difetto, misurato il 2026-08-24. Il sito rilevava già tutto:
 * `recoverableWorkOnBranch` calcola i commit avanti a `main`,
 * `isAvoidableMaxTurns` accetta `hasRecoverableBranch`, e `recoverableMaxTurns`
 * finisce in `$GITHUB_OUTPUT` come `recoverable_max_turns`. Ma quella variabile
 * **non è nominata da nessuno step** di `lessons-harvester.yml`, e il blocco si
 * limitava a un `console.log`: una misura corretta che non raggiungeva nessuno.
 *
 * Sul sito erano **5** branch con lavoro reale — `fix/issue-6315`, `#6270`,
 * `#6206` (3 commit), `#6147`, `#5975` — invisibili a ogni strato del ciclo,
 * perché `stale-pr-rescuer`, `recycle-stale-prs` e `pr-autorebase` raccolgono
 * PR, e un branch senza PR non ne ha mai avuta una.
 */

import { describe, it, expect } from 'vitest';
import {
  ORPHAN_NOTE_MARKER,
  hasOrphanNote,
  orphanNoteBody,
  isAvoidableMaxTurns,
} from '../scripts/ci/harvest-agent-lessons.mjs';

describe('dedup dell\'annotazione', () => {
  it('riconosce un\'annotazione già presente', () => {
    expect(hasOrphanNote([{ body: `testo\n\n${ORPHAN_NOTE_MARKER}` }])).toBe(true);
  });

  it('è falso su un commento che descrive lo stesso fatto senza il marker', () => {
    // La prova è il MARKER, non la prosa: un commento umano che dice la stessa
    // cosa non deve sopprimere l'annotazione automatica, o il dedup diventerebbe
    // sensibile a come qualcuno ha scritto una frase.
    expect(hasOrphanNote([{ body: 'ho visto un branch orfano su fix/issue-1' }])).toBe(false);
  });

  it('tollera lista vuota, null e commenti senza body', () => {
    expect(hasOrphanNote([])).toBe(false);
    expect(hasOrphanNote(null as unknown as [])).toBe(false);
    expect(hasOrphanNote([{}, { body: null }] as unknown as [])).toBe(false);
  });

  it('il dedup NON è una rifinitura: senza, il commento tornerebbe ogni giorno', () => {
    // L'harvester gira daily. Un commento di bot alza `updatedAt`, che è
    // esattamente ciò che affama il cooldown del parked-retry e l'age-out del
    // drainer: il rilevatore diventerebbe la causa del blocco che aiuta a
    // diagnosticare. Il marker è quindi parte del contratto, non cosmetica.
    const body = orphanNoteBody({ issue: 1, branch: 'fix/issue-1', aheadBy: 2 });
    expect(hasOrphanNote([{ body }])).toBe(true);
  });
});

describe('il corpo dell\'annotazione', () => {
  it('porta il marker, il branch e il numero di commit', () => {
    const body = orphanNoteBody({ issue: 6206, branch: 'fix/issue-6206', aheadBy: 3 });
    expect(body).toContain(ORPHAN_NOTE_MARKER);
    expect(body).toContain('fix/issue-6206');
    expect(body).toContain('**3**');
  });

  it('il marker è un commento HTML, quindi invisibile nel corpo reso', () => {
    expect(ORPHAN_NOTE_MARKER).toMatch(/^<!--.*-->$/);
  });

  it('dice perché nessuno strato lo raccoglie: è la parte che evita la ri-diagnosi', () => {
    const body = orphanNoteBody({ issue: 1, branch: 'fix/issue-1', aheadBy: 1 });
    for (const layer of ['stale-pr-rescuer', 'recycle-stale-prs', 'pr-autorebase']) {
      expect(body).toContain(layer);
    }
  });

  it('è lo STESSO marker del corpus, per costruzione', () => {
    // Le due metà rilevano lo stesso fatto con codice diverso — là uno script
    // dedicato, qui `recoverableWorkOnBranch` che questo file ha già — e un
    // marker comune le rende leggibili insieme senza duplicare un rilevatore.
    expect(ORPHAN_NOTE_MARKER).toBe('<!-- orphan-max-turns-work -->');
  });
});

describe('isAvoidableMaxTurns — un branch con lavoro non è un burn evitabile', () => {
  it('hasRecoverableBranch → non contato come loop fixabile', () => {
    expect(isAvoidableMaxTurns('follow-up(#1): una cosa sola', ['follow-up'], {
      hasDeliveredPr: false, hasRecoverableBranch: true,
    })).toBe(false);
  });

  it('senza branch e senza PR resta contato: è il caso da attaccare', () => {
    expect(isAvoidableMaxTurns('follow-up(#1): una cosa sola', ['follow-up'], {
      hasDeliveredPr: false, hasRecoverableBranch: false,
    })).toBe(true);
  });
});
