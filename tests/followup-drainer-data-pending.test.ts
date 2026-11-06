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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectDataPending, cooldownDaysFor } from '../scripts/ci/followup-drainer.mjs';
import { parseFollowupItems } from '../scripts/ci/followup-resolution-match.mjs';

/** Verbatim: titolo e corpo di sito#10831, il bucket giornaliero parcheggiato
 * intero per data-pending il 2026-10-02 con 7 item `open` fermi. */
const BUCKET_10831: { title: string; body: string } = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/followup-drainer/daily-bucket-10831.json', import.meta.url)),
  'utf8',
));

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

// Titolo di fallimento: «Drainer: bucket giornaliero parcheggiato per data-pending».
describe('detectDataPending — un bucket giornaliero è un\'aggregata', () => {
  const DAILY_TITLE = 'follow-up(daily:2026-10-02): 2 items — valerielinc-ops/frontaliere-si-o-no';

  it('sito#10831 (titolo e corpo reali): nessun park dell\'intero bucket', () => {
    // La fixture deve restare il caso che ha prodotto il difetto: un bucket con
    // più item e l'intestazione «post-merge … baseline» che faceva scattare la regex.
    expect(BUCKET_10831.title).toMatch(/^follow-up\(daily:/);
    expect(parseFollowupItems(BUCKET_10831.body).length).toBeGreaterThan(1);
    expect(BUCKET_10831.body).toMatch(/^### .*post-merge.*baseline/m);
    expect(detectDataPending(BUCKET_10831.title, BUCKET_10831.body)).toBeNull();
  });

  it('una riga `blocked: data-pending` in UN item non parla per gli altri', () => {
    const body = [
      '## Item',
      '### FU-2026-10-02-001 — primo',
      '- State: open',
      '- Stato dichiarato nella PR: blocked: data-pending, serve il prossimo deploy',
      '### FU-2026-10-02-002 — secondo',
      '- State: open',
    ].join('\n');
    expect(detectDataPending(DAILY_TITLE, body)).toBeNull();
  });

  it('…ma il marker nel TITOLO del bucket vale ancora per lo scope intero', () => {
    expect(detectDataPending(`${DAILY_TITLE} (blocked, in attesa di dati dal nuovo warning)`, '')).not.toBeNull();
  });

  it('aggregata `3 items deferred` → null come prima', () => {
    expect(detectDataPending('follow-up(#1): 3 items deferred — a, b, c', '- blocked: data-pending')).toBeNull();
  });
});

describe('detectDataPending — un\'intestazione non è una dichiarazione di attesa', () => {
  const PHRASE = 'Full-suite post-merge: report e baseline di performance';

  it('issue singola con la sola intestazione → null', () => {
    expect(detectDataPending('follow-up(#1): item', `### ${PHRASE}\n- State: open`)).toBeNull();
    expect(detectDataPending('follow-up(#1): item', `   ## ${PHRASE}`)).toBeNull();
  });

  it('la stessa frase in una riga di testo resta rilevata', () => {
    expect(detectDataPending('follow-up(#1): item', `- ${PHRASE}`)).toContain('post-merge');
  });

  it('`#123` a inizio riga non è un\'intestazione: la riga si valuta', () => {
    expect(detectDataPending('follow-up(#1): item', '#123 richiede una baseline post-merge')).not.toBeNull();
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
