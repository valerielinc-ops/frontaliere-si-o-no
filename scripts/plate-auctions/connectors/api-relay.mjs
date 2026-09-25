#!/usr/bin/env node
/**
 * Relay attraverso l'API pubblica della Cloud Function per le fonti che il
 * runner GitHub non raggiunge direttamente.
 *
 * `refreshPlateAuctions` gira in europe-west6 (Zurigo) ogni 6 ore e pubblica le
 * righe su `getPlateAuctions`. Il collector statico prova SEMPRE prima la fonte
 * ufficiale; solo se quella fallisce e `PLATE_AUCTION_ENABLE_API_RELAY=1` legge
 * le righe dal relay, e solo quando la fonte nel relay è `active`, ha un
 * `lastSuccessAt` entro la finestra e almeno una riga. Altrimenti l'errore
 * nomina entrambi i fallimenti.
 *
 * Nato per SZ (egress CI rifiutato a intermittenza) e generalizzato il
 * 2026-09-25 per FR e TI, che sono geo-fenced su IP svizzeri: da ogni sonda
 * non svizzera FR dà timeout TCP su 443 e TI la pagina F5 «Pagina non
 * disponibile» (6'967 byte), mentre da Zurigo e Ginevra servono il catalogo
 * eCari. Una sola implementazione, così una correzione alla finestra o ai
 * controlli di salute vale per tutte e tre le fonti.
 */
import { fetchHtml } from "../../../functions/src/plateAuctionsCore.js";

export const PLATE_AUCTION_PUBLIC_API_RELAY_URL =
  "https://europe-west6-frontaliere-ticino.cloudfunctions.net/getPlateAuctions";
// Il collector della function gira ogni 6 ore: 8 ore tollerano un giro in
// ritardo, non un collector fermo. L'envelope `generatedAt` NON è un segnale di
// freschezza (lo timbra il server a ogni richiesta), conta solo `lastSuccessAt`
// della singola fonte.
export const PLATE_AUCTION_API_RELAY_MAX_AGE_MS = 8 * 60 * 60 * 1000;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Righe della fonte `sourceKey` nel payload del relay, oppure un errore se la
 * fonte non è sana, è più vecchia di `maxAgeMs` o non ha righe correnti.
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
  logLabel = `fetch${plateCode}PlateAuctions`,
}) {
  try {
    return await direct();
  } catch (directError) {
    if (process.env.PLATE_AUCTION_ENABLE_API_RELAY !== "1") throw directError;

    try {
      const response = await fetchHtml(relayUrl);
      const payload = JSON.parse(response);
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
