/**
 * followup-drainer — VERDICT-EXIT: l'uscita terminale per i verdetti che
 * `NON_RETRYABLE` sapeva soltanto NON ri-accodare.
 *
 * Il difetto che questi test bloccano, misurato il 2026-08-24 sui due repo:
 * `NON_RETRYABLE` diceva «non ri-accodare» e nient'altro, quindi la issue
 * restava `fu-parked` e APERTA senza che nessuno stadio la guardasse — 55 su 87
 * parked sul sito, 28 su 44 sul corpus. E poiché `isReparkableCandidate` legge
 * solo le label, il PARKED-RETRY spendeva la sua UNICA generazione proprio su
 * quelle: le 8 issue del sito con `fu-reparked:1` avevano tutte e 8 un verdetto
 * NON_RETRYABLE. Su #6020 si vede il costo per intero — parcheggiata il 08-19
 * con `no-root-cause`, ri-accodata alle 01:26 del 08-24, promossa, una run
 * Claude completa fino alle 02:35, stesso `no-root-cause`, ri-parcheggiata con
 * la generazione bruciata.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verdictExitDecision,
  latestFixOutcomeFromComments,
  NON_RETRYABLE,
  VERDICT_ESCALATE,
} from '../scripts/ci/followup-drainer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRAINER_SRC = resolve(__dirname, '../scripts/ci/followup-drainer.mjs');

describe('verdictExitDecision — instradamento per verdetto', () => {
  it('already-fixed → close: il fixer ha guardato e il difetto non c\'era più', () => {
    expect(verdictExitDecision('already-fixed').action).toBe('close');
  });

  it('already-fixed con autoclose spento → flag, non close', () => {
    const d = verdictExitDecision('already-fixed', { noAutoclose: true });
    expect(d.action).toBe('flag');
  });

  it.each([...VERDICT_ESCALATE])('%s → escalate (capacità o causa fuori dalla CI)', (outcome) => {
    expect(verdictExitDecision(outcome).action).toBe('escalate');
  });

  it('ogni verdetto NON_RETRYABLE ha un\'uscita: nessuno resta in limbo', () => {
    // È l'invariante del difetto: un verdetto senza uscita è esattamente lo
    // stato assorbente che questo stadio esiste per eliminare. Aggiungere un
    // codice a NON_RETRYABLE senza instradarlo fa fallire QUESTO test, non una
    // misura fra tre settimane.
    for (const outcome of NON_RETRYABLE) {
      expect(verdictExitDecision(outcome).action, `verdetto senza uscita: ${outcome}`).not.toBe('none');
    }
  });
});

describe('verdictExitDecision — fail-safe nelle due direzioni', () => {
  it('PR fix aperta → none: non si chiude né si escala una issue con lavoro in volo', () => {
    expect(verdictExitDecision('already-fixed', { hasPR: true }).action).toBe('none');
    expect(verdictExitDecision('no-root-cause', { hasPR: true }).action).toBe('none');
  });

  it('nessun verdetto → none: un\'assenza di informazione non genera un\'uscita', () => {
    expect(verdictExitDecision(null).action).toBe('none');
  });

  it('verdetto ri-tentabile → none: lo prende il parked-retry, non questo stadio', () => {
    for (const outcome of ['pr-created', 'max-turns', 'rate-limited', 'overlap-skip']) {
      expect(verdictExitDecision(outcome).action, outcome).toBe('none');
    }
  });

  it('max-turns NON è instradato qui: è lo stadio decompose a occuparsene', () => {
    // Confine fra i due stadi. `max-turns` significa «troppo grande», non
    // «impossibile»: scorporarlo produce valore, escalarlo lo butterebbe.
    expect(NON_RETRYABLE.has('max-turns')).toBe(false);
    expect(verdictExitDecision('max-turns').action).toBe('none');
  });
});

describe('VERDICT-EXIT escalate — regressione #6427 (needs-human morto per sempre)', () => {
  // `verdictExitDecision` è pura e non tocca le label — la mutazione vera
  // (`edit(iss.number, { add, remove })`) vive inline nel branch `escalate` di
  // `main()`, non esportata. Misurato il 2026-08-25 su #6427: quel branch
  // aggiungeva `needs-human` con `remove: []`, lasciando `agent:fix-queued`
  // (o `agent:fix`) insieme a `needs-human` sull'issue. Il drainer esclude
  // `needs-human` (riga ~1116/1651/1755), e il prepass `needs-human` per
  // scelta non tocca issue "già in lavorazione" viste con quelle label — quindi
  // l'issue restava morta per sempre, esclusa da entrambi gli stadi. Non è
  // testabile via `verdictExitDecision` (pura, non chiama `edit`), quindi si
  // scansiona il sorgente: il branch escalate DEVE rimuovere `LBL_FIX` e
  // `LBL_QUEUED` nello stesso `edit()` che aggiunge `needs-human`.
  const src = readFileSync(DRAINER_SRC, 'utf8');

  it('il branch "escalate" del VERDICT-EXIT rimuove agent:fix/agent:fix-queued', () => {
    const marker = 'VERDICT-EXIT escalate #${iss.number}';
    const markerIdx = src.indexOf(marker);
    expect(markerIdx, 'marker di log del branch escalate non trovato — il branch è stato rinominato?').toBeGreaterThan(-1);
    // L'`edit()` che precede il log è la mutazione da verificare.
    const before = src.slice(Math.max(0, markerIdx - 400), markerIdx);
    const editCallIdx = before.lastIndexOf('edit(iss.number,');
    expect(editCallIdx, 'edit() del branch escalate non trovato prima del log').toBeGreaterThan(-1);
    const editCall = before.slice(editCallIdx);
    expect(editCall, editCall).toContain("add: ['needs-human']");
    expect(editCall, editCall).toContain('LBL_FIX');
    expect(editCall, editCall).toContain('LBL_QUEUED');
    expect(editCall, editCall).not.toContain('remove: []');
  });
});

describe('latestFixOutcomeFromComments — accetta anche la forma REST', () => {
  // Il parked-retry ha già i commenti in mano da `issueCommentsRest`, e la
  // guardia che gli impedisce di bruciare una generazione li legge da lì. Con la
  // sola forma GraphQL questa funzione tornava `null` su OGNI lista REST —
  // `Date.parse(undefined)` è NaN — quindi la guardia sarebbe stata muta senza
  // un errore da nessuna parte.
  it('legge `created_at` (REST) come `createdAt` (GraphQL)', () => {
    const rest = [{ body: '<!-- FIX_OUTCOME: no-root-cause -->', created_at: '2026-08-19T10:00:00Z' }];
    expect(latestFixOutcomeFromComments(rest)).toBe('no-root-cause');
  });

  it('ordina correttamente forme miste', () => {
    const mixed = [
      { body: '<!-- FIX_OUTCOME: no-root-cause -->', created_at: '2026-08-19T10:00:00Z' },
      { body: '<!-- FIX_OUTCOME: already-fixed -->', createdAt: '2026-08-22T10:00:00Z' },
    ];
    expect(latestFixOutcomeFromComments(mixed)).toBe('already-fixed');
  });

  it('il backstop resta ignorato anche in forma REST', () => {
    const rest = [
      { body: '<!-- FIX_OUTCOME: blocked-secrets -->', created_at: '2026-08-19T10:00:00Z' },
      { body: '<!-- FIX_OUTCOME: no-pr-unspecified -->\npost-step deterministico', created_at: '2026-08-20T10:00:00Z' },
    ];
    expect(latestFixOutcomeFromComments(rest)).toBe('blocked-secrets');
  });
});

describe('UNPARK-NO-VERDICT — una parked senza verdetto non ha mai avuto un tentativo', () => {
  // Il difetto, misurato il 2026-09-05: `issue-fix.yml` serializzava su un
  // `concurrency` group costante, quindi ogni promozione oltre la prima moriva
  // `cancelled` prima di eseguire uno step. Il RESCUE la ritrovava `agent:fix`
  // orfana e le addebitava un `fu-attempt`; tre giri e la issue era `fu-parked`
  // + `fu-attempt:3` con ZERO commenti `FIX_OUTCOME`. 88 delle 167 parked
  // aperte erano così, 84 parcheggiate il solo 09-04, con 276 label
  // `fu-attempt:*` applicate per tentativi mai avvenuti. Il dry-run di questo
  // passo ne ha contate 72 da ri-accodare (89 nel pool, 17 con un verdetto
  // vero, che restano dove sono).
  const src = readFileSync(DRAINER_SRC, 'utf8');

  it('il predicato è «nessun verdetto», non «nessuna PR» né uno stato', () => {
    // Leggere uno stato al posto della prova è l'errore che qui ha già
    // cancellato 848 iscritti («pending» letto come «non confermato»). Un
    // verdetto è la sola prova che una run ha eseguito.
    expect(src).toContain('if (outcome === null && !has(iss, LBL_UNPARKED)) {');
  });

  it('una lettura commenti fallita non ri-accoda al buio', () => {
    // `issueComments` rende `null` sul glitch e `[]` sull'assenza:
    // `latestFixOutcome` le confonde entrambe in `null`, e su quella confusione
    // un errore di rete diventerebbe un ri-accodo di massa.
    const glitchGuard = src.indexOf('if (comments === null) continue;');
    const decision = src.indexOf('if (outcome === null && !has(iss, LBL_UNPARKED)) {');
    expect(glitchGuard, 'guardia sul glitch gh assente').toBeGreaterThan(-1);
    expect(glitchGuard, 'la guardia deve precedere la decisione').toBeLessThan(decision);
  });

  it('azzera il contatore falso e rimette in coda, marcando il giro', () => {
    // Senza `fu-unparked:1` una issue che tornasse parked-senza-verdetto
    // rientrerebbe in coda a ogni tick per sempre: un livelock al posto di un
    // backlog, cioè un guasto più difficile da vedere e non meno grave.
    const branch = src.slice(
      src.indexOf('if (outcome === null && !has(iss, LBL_UNPARKED)) {'),
      src.indexOf('const d = verdictExitDecision(outcome, {'),
    );
    expect(branch).toContain('add: [LBL_QUEUED, LBL_UNPARKED]');
    expect(branch).toContain('remove: [LBL_PARKED,');
    expect(branch).toContain('/^fu-attempt:\\d+$/');
  });
});
