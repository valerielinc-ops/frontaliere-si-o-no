/**
 * followup-drainer — MAX_ATTEMPTS legato alle label `fu-attempt:N` reali (#5524 item 3).
 *
 * `followup-drainer.mjs` conta i tentativi fino a `MAX_ATTEMPTS` e li scrive
 * come label `fu-attempt:${attempt}` (rescue orfani, riga ~1283); il pass
 * gemello dei crawler usa `CRAWLER_MAX_ATTEMPTS` (default = `MAX_ATTEMPTS`) per
 * lo stesso scopo. `triage-sweep.mjs` mantiene un secondo elenco,
 * `ROUTING_LABELS`, che deve includere ESATTAMENTE le label `fu-attempt:1` fino
 * a `fu-attempt:MAX_ATTEMPTS` — altrimenti una issue etichettata al tetto reale
 * non è più riconosciuta come "già instradata" da `triage-sweep.mjs`, e
 * `gh issue edit --add-label` su una label mai creata (un tetto alzato senza
 * toccare `ROUTING_LABELS`) fallisce zitto: l'issue resta bloccata sul
 * contatore precedente, ritentata a ogni giro senza mai raggiungere
 * `fu-parked`. Nessun test collegava i due prima d'ora — è esattamente il
 * rischio descritto in #5524: "se il codice conta fino a 3 e le label
 * arrivano a 4, le issue restano parcheggiate per sempre senza che nessuno se
 * ne accorga".
 *
 * Questo file non è un mock: legge le costanti VERE esportate dai due moduli,
 * quindi un domani in cui `MAX_ATTEMPTS` cambia senza aggiornare
 * `ROUTING_LABELS` (o viceversa) lo fa fallire senza bisogno di rimisurare
 * niente a mano.
 */

import { describe, it, expect } from 'vitest';
import { MAX_ATTEMPTS, CRAWLER_MAX_ATTEMPTS } from '../scripts/ci/followup-drainer.mjs';
import { ROUTING_LABELS } from '../scripts/ci/triage-sweep.mjs';

/** Le label `fu-attempt:N` presenti in ROUTING_LABELS, N estratto e ordinato. */
function attemptLabelNumbers(labels: string[]): number[] {
  return labels
    .map((l) => /^fu-attempt:(\d+)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

describe('MAX_ATTEMPTS <-> fu-attempt:N label reali (#5524 item 3)', () => {
  it('ROUTING_LABELS contiene esattamente fu-attempt:1..MAX_ATTEMPTS, senza buchi né eccedenze', () => {
    const found = attemptLabelNumbers(ROUTING_LABELS);
    const expected = Array.from({ length: MAX_ATTEMPTS }, (_, i) => i + 1);
    expect(found).toEqual(expected);
  });

  it('CRAWLER_MAX_ATTEMPTS non supera il tetto di label che triage-sweep riconosce', () => {
    // Il default di CRAWLER_MAX_ATTEMPTS è MAX_ATTEMPTS (stesso set di label);
    // un override via env può derogare in debug, ma la label più alta che il
    // rescue crawler può scrivere non deve MAI superare quella che
    // ROUTING_LABELS conosce, o il buco si apre anche dal lato crawler.
    const found = attemptLabelNumbers(ROUTING_LABELS);
    const highestKnown = found.length ? Math.max(...found) : 0;
    expect(CRAWLER_MAX_ATTEMPTS).toBeLessThanOrEqual(highestKnown);
  });

  it('ROUTING_LABELS non porta una label fu-attempt oltre MAX_ATTEMPTS (nessuna eccedenza silenziosa)', () => {
    // Il verso opposto: una label extra mai raggiunta dal contatore non è un
    // bug rischioso quanto quello sopra, ma è comunque drift — un futuro
    // abbassamento di MAX_ATTEMPTS che dimentica di sfoltire questo elenco
    // lascerebbe una label "instradata" che il drainer non scrive più.
    const found = attemptLabelNumbers(ROUTING_LABELS);
    const highest = found.length ? Math.max(...found) : 0;
    expect(highest).toBe(MAX_ATTEMPTS);
  });

  it('sanity: il tetto reale oggi è 3 (non un placeholder di questo test)', () => {
    // Se questo assert va rosso da solo (gli altri tre restano verdi) vuol dire
    // che qualcuno ha alzato MAX_ATTEMPTS E aggiornato ROUTING_LABELS nello
    // stesso giro — corretto, e questa riga va semplicemente aggiornata col
    // nuovo tetto. Se invece va rosso INSIEME a uno degli altri tre, è il
    // difetto che questo file esiste per catturare.
    expect(MAX_ATTEMPTS).toBe(3);
  });
});
