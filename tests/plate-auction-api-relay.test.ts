import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isExplicitlyEmptyCatalogue } from '../functions/src/plateAuctionsCore.js';
import {
  fetchWithPublicApiRelay,
  PLATE_AUCTION_API_RELAY_MAX_AGE_MS,
  PLATE_AUCTION_API_RELAY_READ_ATTEMPTS,
  PLATE_AUCTION_PUBLIC_API_RELAY_URL,
  rowsFromPublicApiRelay,
} from '../scripts/plate-auctions/connectors/api-relay.mjs';
import { EXPANDED_ECARI_SOURCES, fetchExpandedEcari } from '../scripts/plate-auctions/connectors/expanded.mjs';
import { fetchTiPlateAuctions, TI_AUCTION_URL } from '../scripts/plate-auctions/connectors/ti.mjs';
import { SZ_PUBLIC_API_RELAY_URL } from '../scripts/plate-auctions/connectors/sz.mjs';

/**
 * Relay condiviso da SZ, FR e TI (2026-09-25). FR e TI sono geo-fenced su IP
 * svizzeri: dal runner GitHub FR va in timeout su 443 e TI risponde 200 con la
 * pagina F5 «Pagina non disponibile», quindi le loro righe arrivano solo dal
 * relay della Cloud Function di Zurigo. Nessuna rete: `fetch` è finto.
 */
const NOW = new Date('2026-09-25T12:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
const STALE = new Date(NOW.getTime() - PLATE_AUCTION_API_RELAY_MAX_AGE_MS - 60 * 1000).toISOString();
const FR_URL = EXPANDED_ECARI_SOURCES.fr.officialAuctionUrl;
// La pagina che ogni sonda non svizzera riceve da www.carieauktion.ti.ch.
const TI_GEO_BLOCK_PAGE = '<html><head><title>Pagina non disponibile</title></head><body><h1>Pagina non disponibile</h1><p>Support ID: 1234567890</p></body></html>';

type RelaySource = { status?: string; rowCount?: number; lastSuccessAt?: string };
function relayPayload(sources: Record<string, RelaySource>, auctions: Array<Record<string, unknown>>) {
  return { schema: 1, generatedAt: NOW.toISOString(), sources, auctions };
}
const row = (sourceKey: string, id: string) => ({
  id,
  sourceKey,
  normalizedPlate: `${sourceKey}${id.split('-').pop()}`,
  officialAuctionUrl: 'https://relay.example/whatever',
  sourceFetchedAt: FRESH,
  lastVerifiedAt: FRESH,
});

let relayCalls: string[] = [];
function serveRelay(body: unknown, status = 200) {
  relayCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    relayCalls.push(String(url));
    if (/ricardo\.ch|ocn\.ch|carieauktion/.test(String(url))) throw new Error(`unexpected direct fetch ${String(url)}`);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }));
}
// Un corpo 200 diverso per ogni lettura del relay, l'ultimo ripetuto.
function serveRelayBodies(bodies: string[]) {
  relayCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    relayCalls.push(String(url));
    return new Response(bodies[Math.min(relayCalls.length, bodies.length) - 1], { status: 200 });
  }));
}

beforeEach(() => {
  vi.stubEnv('PLATE_AUCTION_ENABLE_API_RELAY', '1');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('rowsFromPublicApiRelay', () => {
  const options = { sourceKey: 'fr', plateCode: 'FR', officialAuctionUrl: FR_URL, now: NOW };

  it('returns only the fresh source rows, pointing at the official portal', () => {
    const rows = rowsFromPublicApiRelay(relayPayload(
      { fr: { status: 'active', rowCount: 2, lastSuccessAt: FRESH } },
      [row('FR', 'fr-1'), row('TI', 'ti-2'), row('FR', 'fr-3')],
    ), options);
    expect(rows.map((item) => item.id)).toEqual(['fr-1', 'fr-3']);
    expect(rows.every((item) => item.officialAuctionUrl === FR_URL)).toBe(true);
  });

  it('refuses a source older than the window, whatever the envelope says', () => {
    expect(() => rowsFromPublicApiRelay(relayPayload(
      { fr: { status: 'active', rowCount: 1, lastSuccessAt: STALE } },
      [row('FR', 'fr-1')],
    ), options)).toThrow('FR API relay source is too old');
  });

  it('refuses an unhealthy source: degraded, blocked, or without a success timestamp', () => {
    for (const source of [
      { status: 'degraded', rowCount: 1, lastSuccessAt: FRESH },
      { status: 'blocked', rowCount: 0 },
      { status: 'active', rowCount: 1 },
    ]) {
      expect(() => rowsFromPublicApiRelay(relayPayload({ fr: source }, [row('FR', 'fr-1')]), options))
        .toThrow('FR API relay source is not healthy');
    }
    expect(() => rowsFromPublicApiRelay(relayPayload({}, [row('FR', 'fr-1')]), options))
      .toThrow('FR API relay source is not healthy');
  });

  it('refuses an inconsistent relay: declared rows missing from the payload, or rows with a zero rowCount', () => {
    expect(() => rowsFromPublicApiRelay(relayPayload(
      { fr: { status: 'active', rowCount: 1, lastSuccessAt: FRESH } },
      [row('TI', 'ti-2')],
    ), options)).toThrow('FR API relay returned no current rows');
    expect(() => rowsFromPublicApiRelay(relayPayload(
      { fr: { status: 'active', rowCount: 0, lastSuccessAt: FRESH } },
      [row('FR', 'fr-1')],
    ), options)).toThrow('FR API relay returned no current rows');
  });

  it('returns the explicit empty catalogue for a source the function read and found empty', () => {
    // Stato scritto solo dal percorso che ha letto il catalogo: active,
    // lastSuccessAt fresco, rowCount 0, errorCode null (es. FR dopo l'asta
    // che chiude il 2026-09-28).
    const empty = rowsFromPublicApiRelay(relayPayload(
      { fr: { status: 'active', rowCount: 0, lastSuccessAt: FRESH, errorCode: null } },
      [row('TI', 'ti-2')],
    ), options);
    expect(isExplicitlyEmptyCatalogue(empty)).toBe(true);
  });

  it('never turns a broken or stale empty source into an empty catalogue', () => {
    // Un fetch rotto e' degraded / zero_rows: resta un errore.
    expect(() => rowsFromPublicApiRelay(relayPayload(
      { fr: { status: 'degraded', rowCount: 0, lastSuccessAt: FRESH, errorCode: 'zero_rows' } },
      [],
    ), options)).toThrow('FR API relay source is not healthy');
    expect(() => rowsFromPublicApiRelay(relayPayload(
      { fr: { status: 'active', rowCount: 0, lastSuccessAt: FRESH, errorCode: 'zero_rows' } },
      [],
    ), options)).toThrow('FR API relay returned no current rows');
    const stale = new Date(NOW.getTime() - 9 * 60 * 60 * 1000).toISOString();
    expect(() => rowsFromPublicApiRelay(relayPayload(
      { fr: { status: 'active', rowCount: 0, lastSuccessAt: stale, errorCode: null } },
      [],
    ), options)).toThrow('FR API relay source is too old');
  });
});

describe('fetchWithPublicApiRelay', () => {
  const base = { sourceKey: 'ti', plateCode: 'TI', officialAuctionUrl: TI_AUCTION_URL, now: NOW };
  const healthy = relayPayload({ ti: { status: 'active', rowCount: 1, lastSuccessAt: FRESH } }, [row('TI', 'ti-1532')]);

  it('shares one relay URL with the SZ connector', () => {
    expect(SZ_PUBLIC_API_RELAY_URL).toBe(PLATE_AUCTION_PUBLIC_API_RELAY_URL);
  });

  it('never calls the relay when the direct fetch succeeds', async () => {
    serveRelay(healthy);
    const direct = [{ id: 'ti-direct' }];
    await expect(fetchWithPublicApiRelay({ ...base, direct: async () => direct })).resolves.toBe(direct);
    expect(relayCalls).toEqual([]);
  });

  it('rethrows the direct error untouched when the relay flag is off', async () => {
    vi.stubEnv('PLATE_AUCTION_ENABLE_API_RELAY', '');
    serveRelay(healthy);
    const directError = new TypeError('fetch failed');
    await expect(fetchWithPublicApiRelay({ ...base, direct: async () => { throw directError; } })).rejects.toBe(directError);
    expect(relayCalls).toEqual([]);
  });

  it('uses a fresh healthy relay after a direct failure', async () => {
    serveRelay(healthy);
    const rows = await fetchWithPublicApiRelay({ ...base, direct: async () => { throw new Error('Timeout fetching'); } });
    expect(rows).toEqual([expect.objectContaining({ id: 'ti-1532', officialAuctionUrl: TI_AUCTION_URL })]);
    expect(relayCalls).toEqual([PLATE_AUCTION_PUBLIC_API_RELAY_URL]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('official endpoint failed; used API relay: Timeout fetching'));
  });

  it('names both failures when the relay cannot serve the source', async () => {
    serveRelay(relayPayload({ ti: { status: 'active', rowCount: 1, lastSuccessAt: STALE } }, [row('TI', 'ti-1532')]));
    await expect(fetchWithPublicApiRelay({ ...base, direct: async () => { throw new Error('geo-blocked'); } }))
      .rejects.toThrow('TI official endpoint failed (geo-blocked); API relay failed (TI API relay source is too old)');
    serveRelay('not found', 404);
    await expect(fetchWithPublicApiRelay({ ...base, direct: async () => { throw new Error('geo-blocked'); } }))
      .rejects.toThrow(/TI official endpoint failed \(geo-blocked\); API relay failed \(HTTP 404/);
    // Un errore HTTP non è un corpo incompleto: una sola lettura.
    expect(relayCalls).toHaveLength(1);
  });

  it('rereads a 200 relay body that is empty or truncated (run 36165624557)', async () => {
    const complete = JSON.stringify(healthy);
    serveRelayBodies(['', complete.slice(0, Math.floor(complete.length / 2)), complete]);
    const rows = await fetchWithPublicApiRelay({
      ...base,
      relayRetryDelayMs: 0,
      direct: async () => { throw new TypeError('fetch failed'); },
    });
    expect(rows).toEqual([expect.objectContaining({ id: 'ti-1532', officialAuctionUrl: TI_AUCTION_URL })]);
    expect(relayCalls).toEqual(Array(3).fill(PLATE_AUCTION_PUBLIC_API_RELAY_URL));
  });

  it('names the reads and the body length when the relay body never parses', async () => {
    serveRelayBodies(['', '{"schema":1,"sources":{']);
    await expect(fetchWithPublicApiRelay({
      ...base,
      relayRetryDelayMs: 0,
      direct: async () => { throw new TypeError('fetch failed'); },
    })).rejects.toThrow(
      /^TI official endpoint failed \(fetch failed\); API relay failed \(relay body is not complete JSON after 3\/3 reads \(23 chars: /,
    );
    expect(relayCalls).toHaveLength(PLATE_AUCTION_API_RELAY_READ_ATTEMPTS);
  });
});

describe('FR and TI connectors read the relay when the direct fetch is geo-blocked', () => {
  it('FR: a TCP timeout on appls.ocn.ch falls back to the relay rows', async () => {
    serveRelay(relayPayload({ fr: { status: 'active', rowCount: 1, lastSuccessAt: FRESH } }, [row('FR', 'fr-1768')]));
    const fetchPage = vi.fn(async () => { throw new Error(`Timeout fetching ${FR_URL}`); });
    const rows = await fetchExpandedEcari('fr', { fetchPage, now: NOW });
    expect(rows).toEqual([expect.objectContaining({ id: 'fr-1768', sourceKey: 'FR', officialAuctionUrl: FR_URL })]);
    // La fetch diretta porta sempre l'intermedio SwissSign che il server omette.
    expect(fetchPage).toHaveBeenCalledWith(FR_URL, expect.objectContaining({ ca: expect.stringContaining('BEGIN CERTIFICATE') }));
  });

  it('TI: the 200 "Pagina non disponibile" page is a direct failure, not an empty catalogue', async () => {
    serveRelay(relayPayload({ ti: { status: 'active', rowCount: 1, lastSuccessAt: FRESH } }, [row('TI', 'ti-1532')]));
    const rows = await fetchTiPlateAuctions({ fetchPage: async () => TI_GEO_BLOCK_PAGE, now: NOW });
    expect(rows).toEqual([expect.objectContaining({ id: 'ti-1532', officialAuctionUrl: TI_AUCTION_URL })]);

    vi.stubEnv('PLATE_AUCTION_ENABLE_API_RELAY', '');
    await expect(fetchTiPlateAuctions({ fetchPage: async () => TI_GEO_BLOCK_PAGE, now: NOW }))
      .rejects.toThrow('did not serve an eCari catalogue (no tabContent1)');
  });

  it('TI: a served eCari catalogue is parsed directly and the relay is never read', async () => {
    serveRelay(relayPayload({}, []));
    const page = `<div id="tabContent1"><table><tbody><tr class="L">
      <td><a onclick="openDetails(1532)"><div class="number">13457</div></a></td>
      <td class="amount">500</td><td class="amount">50</td><td class="amount">650</td>
      <td class="closingTime">2026/10/04 20:00:00</td><td>3</td></tr></tbody></table></div>`;
    const rows = await fetchTiPlateAuctions({ fetchPage: async () => page, now: NOW });
    expect(rows).toEqual([expect.objectContaining({ id: 'ti-1532', normalizedPlate: 'TI13457', currentBidChf: 650 })]);
    expect(relayCalls).toEqual([]);
  });
});
