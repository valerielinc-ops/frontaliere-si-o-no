/**
 * followup-drainer — `detectDataPending` + `cooldownDaysFor`.
 *
 * Un bullet che dice di aspettare dati o run future prima che l'item sia
 * giudicabile non è un fix producibile oggi (promuoverlo brucia un run che
 * riscopre ogni volta lo stesso vincolo) ma non è nemmeno terminale: fra una
 * settimana il dato c'è. Prima di questo ramo il drainer non aveva la
 * categoria — l'issue restava in coda e o veniva promossa a vuoto o restava
 * ferma senza che nessuno dichiarasse il perché.
 *
 * L'esito è `fu-parked` + `fu-data-pending`, MAI `needs-human`: quello è uno
 * stato assorbente per `isReparkableCandidate` e la issue non tornerebbe mai in
 * coda — cioè il «ferma per sempre» che questo ramo esiste per togliere.
 *
 * Fixture verbatim dalle follow-up aperte il 2026-08-25.
 */
import { describe, it, expect } from 'vitest';
import { detectDataPending, cooldownDaysFor } from '../scripts/ci/followup-drainer.mjs';

/** Verbatim: titolo di corpus#464. */
const T_464 = "follow-up(#445): criterio di silenzio per admit da valutare al posto dell'eta' (blocked, in attesa di dati dal nuovo warning)";
/** Verbatim: titolo di corpus#511 — «serve baseline» nel titolo. */
const T_511 = 'follow-up(#465): gemello sito exhaustion-disposition.mjs non portato (blocked) + gate CI per exit 124 di generate-article (blocked, serve baseline)';
/** Verbatim: la riga di sito#6222 che porta il marker nel BODY. */
const L_6222 = 'Item escluso in dedup: la voce originale della PR body su "soglie dist:quality-tests al 60%, blocked: serve la misura di due o tre run consecutivi" e\' duplicate of #6192 item 1.';

const lbl = (...names: string[]) => ({ labels: names.map((name) => ({ name })) });

describe('detectDataPending — forme reali', () => {
  it('corpus#464: «in attesa di dati» nel titolo', () => {
    expect(detectDataPending(T_464, 'body qualsiasi')).toContain('in attesa di dati');
  });

  it('corpus#511: «serve baseline» nel titolo', () => {
    expect(detectDataPending(T_511, '')).toContain('serve baseline');
  });

  it('sito#6222: «serve la misura di due o tre run consecutivi» nel body, issue da 1 item', () => {
    const hit = detectDataPending('follow-up(#6216): 1 item deferred — audit rossi', L_6222);
    expect(hit).toContain('serve la misura di due');
  });

  it('la forma canonica `blocked: data-pending` è riconosciuta', () => {
    expect(detectDataPending('follow-up(#1): item', '- blocked: data-pending, serve il prossimo deploy')).not.toBeNull();
  });

  it('«richiede una baseline post-merge» e «non è ancora valutabile»', () => {
    expect(detectDataPending('x', '- richiede una baseline post-merge')).not.toBeNull();
    expect(detectDataPending('x', "- non e' ancora valutabile senza il ledger")).not.toBeNull();
  });
});

describe('detectDataPending — conservativo: un bullet non parla per gli altri', () => {
  it('aggregata da 4 item con UN solo bullet data-pending nel body → nessun park', () => {
    const title = 'follow-up(#6330): 4 item deferred — interviste, SERP, collisione, troncamento';
    expect(detectDataPending(title, `### 1. Interviste\n### 2. SERP\n### 3. Collisione\n### 4. ${L_6222}`)).toBeNull();
  });

  it('…ma se il marker sta nel TITOLO descrive lo scope INTERO → park anche se aggregata', () => {
    const title = 'follow-up(#445): 4 item deferred (blocked, in attesa di dati dal nuovo warning)';
    expect(detectDataPending(title, '### 1. a\n### 2. b\n### 3. c\n### 4. d')).not.toBeNull();
  });

  it('prosa neutra sui dati non basta (bias a promuovere)', () => {
    expect(detectDataPending('follow-up(#1): item', 'Il report mostra i dati delle ultime run.')).toBeNull();
    expect(detectDataPending('follow-up(#1): item', 'Aggiungere una baseline al test.')).toBeNull();
  });

  it('titolo/body vuoti → null', () => {
    expect(detectDataPending('', '')).toBeNull();
  });
});

describe('cooldownDaysFor — la variante lunga vale SOLO per le data-pending', () => {
  it('una parcheggiata normale usa il cooldown base', () => {
    expect(cooldownDaysFor(lbl('fu-parked'), { base: 5, dataPending: 10 })).toBe(5);
  });

  it('una `fu-data-pending` usa il cooldown lungo', () => {
    expect(cooldownDaysFor(lbl('fu-parked', 'fu-data-pending'), { base: 5, dataPending: 10 })).toBe(10);
  });

  it('issue senza label / malformata → cooldown base (fail-safe, non allunga a caso)', () => {
    expect(cooldownDaysFor({}, { base: 5, dataPending: 10 })).toBe(5);
    expect(cooldownDaysFor(undefined, { base: 5, dataPending: 10 })).toBe(5);
  });

  it('il default è il doppio del cooldown base, non un numero scollegato', () => {
    // Nessun override: la relazione fra i due valori è il contratto, non il valore.
    expect(cooldownDaysFor(lbl('fu-parked', 'fu-data-pending')))
      .toBe(cooldownDaysFor(lbl('fu-parked')) * 2);
  });
});
