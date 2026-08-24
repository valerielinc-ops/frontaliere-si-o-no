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
import {
  verdictExitDecision,
  latestFixOutcomeFromComments,
  NON_RETRYABLE,
  VERDICT_ESCALATE,
} from '../scripts/ci/followup-drainer.mjs';

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
