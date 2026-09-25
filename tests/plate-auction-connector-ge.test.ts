import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchGePlateAuctions as fetchGeCore,
  GE_PLATE_AUCTION_SOURCE,
  isExplicitlyEmptyCatalogue,
  parseGeAuctionSessionWindow,
  parseGePlateAuctionListPdfText,
} from '../functions/src/plateAuctionsCore.js';
import { PLATE_AUCTION_SOURCE_COLLECTION, refreshPlateAuctions } from '../functions/src/plateAuctions.js';
import { fetchGePlateAuctions } from '../scripts/plate-auctions/connectors/ge.mjs';
import { validatePlateAuction } from '../services/plateAuctions/types';

// Solo in questo file GE è `active`: serve a provare il cablaggio nella Cloud
// Function. Il registry vero la tiene `blocked` fino alla lista d'autunno.
vi.mock('../functions/src/plateAuctionSourceRegistry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../functions/src/plateAuctionSourceRegistry.js')>();
  const registry = actual.PUBLIC_PLATE_AUCTION_SOURCE_REGISTRY;
  return { PUBLIC_PLATE_AUCTION_SOURCE_REGISTRY: { ...registry, ge: { ...registry.ge, status: 'active' } } };
});

/**
 * Testo minimo scritto a mano sul layout reale di vente_enchere_pl_prosp_mai_26.pdf
 * (https://www.ge.ch/document/22794/telecharger, pubblicato il 2026-04-15): punto
 * 1 con la finestra, punto 8 con 12 auto, 6 moto e 1 lotto, punto 9 dopo la lista.
 * Il PDF non è nel repo: da ge.ch si estraggono fatti e si linka il documento.
 */
const MAY_2026 = readFileSync(new URL('./fixtures/ge-plate-auction-list-may-2026.txt', import.meta.url), 'utf8');
const MAY_PDF = 'https://www.ge.ch/document/22794/telecharger';
const NOV_PDF = 'https://www.ge.ch/document/15062/telecharger';
const DAY = 24 * 60 * 60 * 1000;

const FRENCH_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const zurichDate = (ms: number) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Zurich', year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(ms).map((part) => [part.type, part.value]));
  return { day: Number(parts.day), month: Number(parts.month), year: Number(parts.year) };
};
/** La lista di maggio con la sessione spostata fra `startInDays` e `endInDays` giorni da `now`. */
function listWithSession(now: Date, startInDays: number, endInDays: number) {
  const start = zurichDate(now.getTime() + startInDays * DAY);
  const end = zurichDate(now.getTime() + endInDays * DAY);
  const sentence = `dès le ${start.day} ${FRENCH_MONTHS[start.month - 1]} ${start.year} au ${end.day} ${FRENCH_MONTHS[end.month - 1]} ${end.year}, 11h00`;
  return MAY_2026.replace('dès le 11 au 20 mai 2026, 11h00', sentence);
}

const AUCTION_PAGE_DURING_SESSION = `<html><head><title>Vente aux enchères de plaques | ge.ch</title></head><body>
  <div class="body rich-content"><p>Prochaine vente :&nbsp; du 11 au 20 mai 2026</p>
  <p><a href="/node/22794">Liste des numéros proposés à la vente</a></p>
  <p><a href="/node/15061">Règlement sur la vente aux enchères de plaques d'immatriculation</a></p>
  <p>Pour miser : <a href="https://www.ricardo.ch/fr/s/ENCHERES-PLAQUES-GE/">cliquez ici jusqu'au 20 mai 2026, 11h00.</a></p></div></body></html>`;
const AUCTION_PAGE_BETWEEN_SESSIONS = '<html><head><title>Vente aux enchères de plaques | ge.ch</title></head><body><p>Prochaine vente : automne 2026.</p></body></html>';
const documentPage = (title: string, updated: string, id: number) => `<html><head><title>${title} | ge.ch</title>
  <meta property="og:updated_time" content="${updated}" /></head>
  <body><a href="/document/${id}/telecharger">vente_enchere_pl_prosp.pdf</a></body></html>`;

/** ge.ch finto: pagina d'asta, pagine documento, testo dei PDF. Ogni URL richiesto resta registrato. */
function fakeGeCh({ auctionPage = AUCTION_PAGE_DURING_SESSION, pdfTexts = { [MAY_PDF]: MAY_2026, [NOV_PDF]: MAY_2026 } as Record<string, string>, missing = [] as string[] } = {}) {
  const requested: string[] = [];
  const pages: Record<string, string> = {
    [GE_PLATE_AUCTION_SOURCE.pageUrl]: auctionPage,
    'https://www.ge.ch/node/22794': documentPage('Liste numéros de plaques mis aux enchères', '2026-04-15T17:13:47+0200', 22794),
    'https://www.ge.ch/document/liste-numeros-plaques-mis-aux-encheres': documentPage('Liste numéros de plaques mis aux enchères', '2026-04-15T17:13:47+0200', 22794),
    'https://www.ge.ch/document/liste-plaques-aux-encheres': documentPage('Liste des plaques aux enchères', '2025-10-17T14:30:06+0200', 15062),
  };
  const fetcher = async (url: string, options: { responseType?: string } = {}) => {
    requested.push(url);
    if (/ricardo/i.test(url)) throw new Error(`Ricardo must never be fetched: ${url}`);
    if (missing.includes(url)) throw new Error(`HTTP 404 from ${url}`);
    if (options.responseType === 'pdf-text') {
      if (!(url in pdfTexts)) throw new Error(`HTTP 404 from ${url}`);
      return { text: pdfTexts[url], pages: [pdfTexts[url]] };
    }
    return pages[url] ?? '';
  };
  return { fetcher, requested };
}

describe('GE auction list parser (May 2026 layout)', () => {
  it('reads the session window and the 12 car, 6 motorcycle and 1 lot numbers', () => {
    expect(parseGeAuctionSessionWindow(MAY_2026)).toMatchObject({
      // «dès le 11»: nessuna ora d'inizio nel PDF → mezzanotte di Zurigo.
      startsAt: '2026-05-10T22:00:00.000Z',
      endsAt: '2026-05-20T09:00:00.000Z',
    });
    const rows = parseGePlateAuctionListPdfText(MAY_2026, { pdfUrl: MAY_PDF, fetchedAt: '2026-05-01T08:00:00.000Z' });
    expect(rows.filter((row) => row.vehicleType === 'car').map((row) => row.plateNumber)).toEqual(
      ['6226', '8484', '66698', '71771', '91134', '522222', '558858', '820000', '830000', '840000', '887777', '889999'],
    );
    expect(rows.filter((row) => row.vehicleType === 'motorcycle').map((row) => row.plateNumber)).toEqual(
      ['2570', '8444', '10100', '58885', '111111', '150000'],
    );
    expect(rows.filter((row) => row.vehicleType === 'other')).toEqual([
      expect.objectContaining({ id: 'ge-20260520-lot-100069', plateNumber: '100069', sourceCategory: 'official-auction-list-lot-car-motorcycle' }),
    ]);
    expect(rows).toHaveLength(19);
  });

  it('publishes numbers and dates only, linking the PDF and the Ricardo shop', () => {
    const rows = parseGePlateAuctionListPdfText(MAY_2026, { pdfUrl: MAY_PDF, fetchedAt: '2026-05-01T08:00:00.000Z' });
    for (const row of rows) {
      expect(row).toMatchObject({
        sourceKey: 'GE', listingType: 'auction', dataConfidence: 'partial',
        officialDetailUrl: MAY_PDF, officialAuctionUrl: 'https://www.ricardo.ch/fr/shop/ENCHERES-PLAQUES-GE/offers/',
      });
      for (const field of ['currentBidChf', 'startingPriceChf', 'finalPriceChf', 'bidCount', 'minimumIncrementChf']) {
        expect(row, field).not.toHaveProperty(field);
      }
      expect(validatePlateAuction(row)).toEqual([]);
    }
    expect(rows[0]).toMatchObject({ id: 'ge-20260520-6226', normalizedPlate: 'GE6226' });
    expect(rows.find((row) => row.vehicleType === 'motorcycle')).toMatchObject({ id: 'ge-20260520-motorcycle-2570' });
  });

  it('marks rows upcoming before the session and active while it runs', () => {
    const before = parseGePlateAuctionListPdfText(MAY_2026, { fetchedAt: '2026-05-01T08:00:00.000Z' });
    const during = parseGePlateAuctionListPdfText(MAY_2026, { fetchedAt: '2026-05-15T08:00:00.000Z' });
    expect(new Set(before.map((row) => row.auctionStatus))).toEqual(new Set(['upcoming']));
    expect(new Set(during.map((row) => row.auctionStatus))).toEqual(new Set(['active']));
    expect(during[0]).toMatchObject({ startsAt: '2026-05-10T22:00:00.000Z', endsAt: '2026-05-20T09:00:00.000Z' });
  });

  it('returns the explicit empty catalogue once the session has ended', () => {
    const rows = parseGePlateAuctionListPdfText(MAY_2026, { fetchedAt: '2026-09-25T08:00:00.000Z' });
    expect(rows).toEqual([]);
    expect(isExplicitlyEmptyCatalogue(rows)).toBe(true);
    // Il minuto della chiusura è già «finita».
    expect(isExplicitlyEmptyCatalogue(parseGePlateAuctionListPdfText(MAY_2026, { fetchedAt: '2026-05-20T09:00:00.000Z' }))).toBe(true);
  });

  it('reads a session that spans two months, across the DST change', () => {
    expect(parseGeAuctionSessionWindow('ce dès le 28 octobre au 6 novembre 2026, 11h00.')).toMatchObject({
      startsAt: '2026-10-27T23:00:00.000Z',
      endsAt: '2026-11-06T10:00:00.000Z',
    });
    expect(parseGeAuctionSessionWindow('ce dès le 3 au 13 novembre 2025, 11h00.')).toMatchObject({
      startsAt: '2025-11-02T23:00:00.000Z',
      endsAt: '2025-11-13T10:00:00.000Z',
    });
  });

  it('fails closed on a list without a session window or without numbers', () => {
    expect(() => parseGePlateAuctionListPdfText(MAY_2026.replace('dès le 11 au 20 mai 2026, 11h00', 'prochainement')))
      .toThrow('GE: the auction list has no parsable session window');
    expect(() => parseGePlateAuctionListPdfText(MAY_2026.replace(/GE \d+/g, '')))
      .toThrow('GE: the auction list has no plate numbers');
    // Un numero dopo la lista (punto 9) non è in vendita.
    const withTrailingNumber = MAY_2026.replace('9. Pour tout', '9. Voir aussi GE 1. Pour tout');
    expect(parseGePlateAuctionListPdfText(withTrailingNumber, { fetchedAt: '2026-05-01T08:00:00.000Z' })).toHaveLength(19);
  });
});

describe('GE list discovery on ge.ch', () => {
  it('follows the list linked by the auction page, picks the newest document and never fetches Ricardo', async () => {
    const geCh = fakeGeCh();
    const rows = await fetchGeCore({ fetchedAt: '2026-05-15T08:00:00.000Z', injectedFetcher: geCh.fetcher });
    expect(rows).toHaveLength(19);
    expect(rows[0]).toMatchObject({ officialDetailUrl: MAY_PDF, auctionStatus: 'active' });
    expect(geCh.requested).toContain('https://www.ge.ch/node/22794');
    expect(geCh.requested.filter((url) => url.endsWith('/telecharger'))).toEqual([MAY_PDF]);
    expect(geCh.requested.every((url) => url.startsWith('https://www.ge.ch/'))).toBe(true);
  });

  it('between sessions reads the seeded list slugs and answers with an explicit empty catalogue', async () => {
    const geCh = fakeGeCh({ auctionPage: AUCTION_PAGE_BETWEEN_SESSIONS, missing: ['https://www.ge.ch/document/liste-plaques-aux-encheres'] });
    const rows = await fetchGeCore({ fetchedAt: '2026-09-25T08:00:00.000Z', injectedFetcher: geCh.fetcher });
    expect(isExplicitlyEmptyCatalogue(rows)).toBe(true);
    expect(geCh.requested.some((url) => /ricardo/i.test(url))).toBe(false);
  });

  it('fails when no plate-auction list can be found', async () => {
    const empty = async (url: string) => {
      if (/ricardo/i.test(url)) throw new Error('Ricardo must never be fetched');
      return '<html><head><title>Page | ge.ch</title></head></html>';
    };
    await expect(fetchGeCore({ fetchedAt: '2026-09-25T08:00:00.000Z', injectedFetcher: empty })).rejects.toThrow(/GE: no plate-auction list found/);
  });

  it('is exposed unchanged by the static connector', async () => {
    const geCh = fakeGeCh();
    const rows = await fetchGePlateAuctions({ now: new Date('2026-05-01T08:00:00.000Z'), injectedFetcher: geCh.fetcher });
    expect(rows).toHaveLength(19);
    expect(new Set(rows.map((row) => row.auctionStatus))).toEqual(new Set(['upcoming']));
  });
});

/** Firestore minimo: set con merge, where+limit, batch. */
function memoryFirestore() {
  type Doc = Record<string, unknown>;
  const stores = new Map<string, Map<string, Doc>>();
  const store = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  const apply = (name: string, id: string, value: Doc, merge: boolean) => {
    store(name).set(id, { ...(merge ? store(name).get(id) || {} : {}), ...value });
  };
  const collection = (name: string) => ({
    doc: (id: string) => ({ collection: name, id, async set(value: Doc, options?: { merge?: boolean }) { apply(name, id, value, options?.merge === true); } }),
    where: (field: string, _operator: string, value: unknown) => ({
      limit: () => ({ get: async () => ({ docs: [...store(name).entries()].filter(([, doc]) => doc[field] === value).map(([id, doc]) => ({ id, data: () => ({ ...doc }) })) }) }),
    }),
    limit: () => ({ get: async () => ({ docs: [] }) }),
  });
  return {
    db: {
      collection,
      batch() {
        const operations: Array<() => void> = [];
        return {
          set(ref: { collection: string; id: string }, value: Doc, options?: { merge?: boolean }) { operations.push(() => apply(ref.collection, ref.id, value, options?.merge === true)); },
          delete(ref: { collection: string; id: string }) { operations.push(() => { store(ref.collection).delete(ref.id); }); },
          async commit() { for (const operation of operations) operation(); },
        };
      },
    },
    store,
  };
}

describe('GE in the Cloud Function once the registry marks it active', () => {
  const now = new Date();
  const refresh = (firestore: ReturnType<typeof memoryFirestore>, listText: string) => {
    const geCh = fakeGeCh({ pdfTexts: { [MAY_PDF]: listText, [NOV_PDF]: listText } });
    const fetcher = async (url: string, options: { responseType?: string } = {}) => (url.includes('www.ge.ch') || /ricardo/i.test(url) ? geCh.fetcher(url, options) : '');
    return { run: refreshPlateAuctions({ db: firestore.db as never, fetcher: fetcher as never, now }), geCh };
  };

  it('publishes the upcoming session rows and marks the source healthy', async () => {
    const firestore = memoryFirestore();
    const { run, geCh } = refresh(firestore, listWithSession(now, 10, 19));
    const result = await run;
    expect(result.summaries.ge).toMatchObject({ status: 'active', rowCount: 19 });
    expect(firestore.store(PLATE_AUCTION_SOURCE_COLLECTION).get('ge')).toMatchObject({ status: 'active', errorCode: null, lastSuccessAt: now.toISOString() });
    const rows = [...firestore.store('plate_auctions_current').values()].filter((row) => row.sourceKey === 'GE');
    expect(rows).toHaveLength(19);
    expect(new Set(rows.map((row) => row.auctionStatus))).toEqual(new Set(['upcoming']));
    expect(geCh.requested.some((url) => /ricardo/i.test(url))).toBe(false);
  });

  it('treats an ended session as an answered, empty catalogue, not as zero_rows', async () => {
    const firestore = memoryFirestore();
    const { run } = refresh(firestore, listWithSession(now, -20, -11));
    const result = await run;
    expect(result.summaries.ge).toMatchObject({ status: 'active', rowCount: 0 });
    expect(firestore.store(PLATE_AUCTION_SOURCE_COLLECTION).get('ge')).toMatchObject({ status: 'active', errorCode: null });
  });
});
