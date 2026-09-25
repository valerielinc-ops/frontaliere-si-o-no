#!/usr/bin/env node
/**
 * Relay attraverso l'API pubblica della Cloud Function per le fonti che il
 * runner GitHub non raggiunge direttamente.
 *
 * `refreshPlateAuctions` gira in europe-west6 (Zurigo) ogni 6 ore e pubblica le
 * righe su `getPlateAuctions`. Il collector statico prova SEMPRE prima la fonte
 * ufficiale; solo se quella fallisce e `PLATE_AUCTION_ENABLE_API_RELAY=1` legge
 * le righe dal relay, e solo quando la fonte nel relay è `active` e ha un
 * `lastSuccessAt` entro la finestra. Altrimenti l'errore nomina entrambi i
 * fallimenti. Una fonte `active`, fresca, con `rowCount` 0 e senza
 * `errorCode` è il catalogo vuoto esplicito (vedi `rowsFromPublicApiRelay`).
 *
 * Nato per SZ (egress CI rifiutato a intermittenza) e generalizzato il
 * 2026-09-25 per FR e TI, che sono geo-fenced su IP svizzeri: da ogni sonda
 * non svizzera FR dà timeout TCP su 443 e TI la pagina F5 «Pagina non
 * disponibile» (6'967 byte), mentre da Zurigo e Ginevra servono il catalogo
 * eCari. Una sola implementazione, così una correzione alla finestra o ai
 * controlli di salute vale per tutte e tre le fonti.
 */
import {
  explicitlyEmptyCatalogue,
  fetchHtml,
} from "../../../functions/src/plateAuctionsCore.js";

export const PLATE_AUCTION_PUBLIC_API_RELAY_URL =
  "https://europe-west6-frontaliere-ticino.cloudfunctions.net/getPlateAuctions";
// Il collector della function gira ogni 6 ore: 8 ore tollerano un giro in
// ritardo, non un collector fermo. L'envelope `generatedAt` NON è un segnale di
// freschezza (lo timbra il server a ogni richiesta), conta solo `lastSuccessAt`
// della singola fonte.
export const PLATE_AUCTION_API_RELAY_MAX_AGE_MS = 8 * 60 * 60 * 1000;
// Letture del relay quando la risposta è 2xx ma il corpo non è JSON completo.
// `fetchHtml` ripete già gli errori HTTP e di rete; un corpo vuoto o troncato
// arriva invece a JSON.parse. Il payload pesa ~16 MB (Basel-Stadt pubblica
// ~16'000 righe) e ogni connettore lo legge per conto suo: nella run
// 36165624557 (2026-09-25 17:16Z) SZ è finito `fetch_failed` con «Unexpected
// end of JSON input», mentre FR e TI un minuto prima e dopo avevano letto lo
// stesso relay senza errori.
export const PLATE_AUCTION_API_RELAY_READ_ATTEMPTS = 3;
const PLATE_AUCTION_API_RELAY_RETRY_DELAY_MS = 2000;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Payload del relay già parsato. Un corpo che non è JSON completo viene riletto
 * fino a `attempts` volte; l'errore finale riporta la lunghezza del corpo, così
 * il log distingue una risposta vuota da una troncata.
 */
export async function readPublicApiRelayPayload(relayUrl, {
  attempts = PLATE_AUCTION_API_RELAY_READ_ATTEMPTS,
  retryDelayMs = PLATE_AUCTION_API_RELAY_RETRY_DELAY_MS,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const body = await fetchHtml(relayUrl);
    try {
      return JSON.parse(body);
    } catch (parseError) {
      lastError = new Error(
        `relay body is not complete JSON after ${attempt}/${attempts} reads (${body.length} chars: ${errorMessage(parseError)})`,
        { cause: parseError },
      );
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  throw lastError;
}

/**
 * Righe della fonte `sourceKey` nel payload del relay, oppure un errore se la
 * fonte non è sana, è più vecchia di `maxAgeMs` o dichiara righe che il
 * payload non contiene. Una fonte che la function ha letto e trovato vuota
 * torna come catalogo vuoto esplicito.
 */
export function rowsFromPublicApiRelay(payload, {
  sourceKey,
  plateCode,
  officialAuctionUrl,
  now,
  maxAgeMs = PLATE_AUCTION_API_RELAY_MAX_AGE_MS,
}) {
  const source = payload?.sources?.[sourceKey];
  const lastSuccessAt = source?.lastSuccessAt;
  const lastSuccessMs = Date.parse(lastSuccessAt || "");
  if (source?.status !== "active" || !Number.isFinite(lastSuccessMs)) {
    throw new Error(`${plateCode} API relay source is not healthy`);
  }
  if (now.getTime() - lastSuccessMs > maxAgeMs) {
    throw new Error(`${plateCode} API relay source is too old`);
  }
  const rows = Array.isArray(payload?.auctions)
    ? payload.auctions.filter((row) => String(row?.sourceKey || "").toUpperCase() === plateCode)
    : [];
  // Catalogo vuoto esplicito (pagina eCari «nessuna asta in corso», sessione
  // finita). `refreshPlateAuctions` scrive `active` con `lastSuccessAt` fresco,
  // `rowCount` 0 ed `errorCode` null SOLO dal percorso che ha letto il
  // catalogo. Un fetch rotto o vuoto senza quello stato diventa `degraded` /
  // `zero_rows` e non aggiorna `lastSuccessAt`, quindi si ferma sopra. Senza
  // questo ramo FR, TI e SZ andavano `fetch_failed` a ogni giro fra due aste,
  // mentre una fonte raggiunta direttamente registra lo stesso stato come
  // risposto. Il collector statico lo tratta come la fetch diretta: chiude le
  // righe scadute e conserva le altre.
  if (rows.length === 0 && Number(source.rowCount) === 0 && !source.errorCode) {
    return explicitlyEmptyCatalogue();
  }
  if (rows.length === 0 || Number(source.rowCount) < 1) {
    throw new Error(`${plateCode} API relay returned no current rows`);
  }
  return rows.map((row) => ({
    ...row,
    officialAuctionUrl,
  }));
}

/**
 * Esegue `direct()`; se fallisce e il relay è abilitato, restituisce le righe
 * del relay per la stessa fonte. `logLabel` è il prefisso del warning, così il
 * log dice quale connettore ha usato il relay.
 */
export async function fetchWithPublicApiRelay({
  sourceKey,
  plateCode,
  officialAuctionUrl,
  direct,
  now = new Date(),
  maxAgeMs = PLATE_AUCTION_API_RELAY_MAX_AGE_MS,
  relayUrl = PLATE_AUCTION_PUBLIC_API_RELAY_URL,
  relayRetryDelayMs = PLATE_AUCTION_API_RELAY_RETRY_DELAY_MS,
  logLabel = `fetch${plateCode}PlateAuctions`,
}) {
  try {
    return await direct();
  } catch (directError) {
    if (process.env.PLATE_AUCTION_ENABLE_API_RELAY !== "1") throw directError;

    try {
      const payload = await readPublicApiRelayPayload(relayUrl, { retryDelayMs: relayRetryDelayMs });
      const rows = rowsFromPublicApiRelay(payload, {
        sourceKey,
        plateCode,
        officialAuctionUrl,
        now,
        maxAgeMs,
      });
      console.warn(`[${logLabel}] official endpoint failed; used API relay: ${errorMessage(directError)}`);
      return rows;
    } catch (relayError) {
      throw new Error(
        `${plateCode} official endpoint failed (${errorMessage(directError)}); API relay failed (${errorMessage(relayError)})`,
        { cause: relayError },
      );
    }
  }
}
