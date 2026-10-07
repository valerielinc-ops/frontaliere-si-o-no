/**
 * run-listing-window.mjs — finestra `created` per gli elenchi di run filtrati
 * per `branch`.
 *
 * `GET /repos/<repo>/actions/[workflows/<wf>/]runs?branch=<b>` (anche con
 * `status=`) restituisce a tratti un elenco fermo a settimane o mesi prima:
 * misurato il 2026-09-28 (run del 22-06 e del 27-07 in testa) e il 2026-10-02
 * sul resolver dell'artifact Pages (150 candidati, il piu' recente del 16-08,
 * mentre le build del giorno esistevano). Con `created=>=<data>` l'API torna
 * all'elenco corrente. `gh run list --branch` usa lo stesso endpoint: il suo
 * equivalente e' `--created '>=<data>'`.
 *
 * Regola: ogni elenco di run filtrato per `branch` porta una finestra
 * `created` dimensionata sull'uso del chiamante, e la scelta della run «piu'
 * recente» si fa ordinando in locale, mai fidandosi dell'ordine della
 * risposta. Osservatore: `tests/run-listing-created-window.test.ts`.
 */

const DAY_MS = 86_400_000;

/**
 * Data (UTC, `AAAA-MM-GG`) di `days` giorni fa. Tronca al giorno: la finestra
 * reale e' quindi fra `days` e `days + 1` giorni, mai piu' corta di `days`.
 */
export function createdSince(days, nowMs = Date.now()) {
  if (!Number.isFinite(days) || days <= 0) {
    throw new TypeError(`createdSince: days must be a positive number, got ${days}`);
  }
  return new Date(nowMs - days * DAY_MS).toISOString().slice(0, 10);
}

/** Valore per `gh run list --created`: `>=AAAA-MM-GG`. */
export function createdSinceFilter(days, nowMs = Date.now()) {
  return `>=${createdSince(days, nowMs)}`;
}

/** Parametro di query REST gia' codificato: `created=%3E%3DAAAA-MM-GG`. */
export function createdSinceQuery(days, nowMs = Date.now()) {
  return `created=${encodeURIComponent(createdSinceFilter(days, nowMs))}`;
}

/**
 * Data UTC di un istante gia' noto, per un filtro `created` inclusivo.
 * L'API di GitHub accetta una data, non un timestamp: il giorno viene quindi
 * conservato per intero e la selezione precisa resta al chiamante.
 */
export function createdFromFilter(value) {
  const timestamp = value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value
      : Date.parse(String(value ?? ''));
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`createdFromFilter: invalid timestamp, got ${value}`);
  }
  return `>=${new Date(timestamp).toISOString().slice(0, 10)}`;
}

function createdAtMs(run) {
  const value = Date.parse(run?.created_at ?? run?.createdAt ?? '');
  return Number.isFinite(value) ? value : -Infinity;
}

/**
 * Copia dell'elenco ordinata dalla run creata piu' di recente. Accetta sia la
 * forma REST (`created_at`) sia quella di `gh run list --json` (`createdAt`);
 * una run senza data valida finisce in fondo.
 */
export function newestFirst(runs) {
  return [...(Array.isArray(runs) ? runs : [])].sort((left, right) => createdAtMs(right) - createdAtMs(left));
}
