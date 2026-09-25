#!/usr/bin/env node
/**
 * Ginevra: lista ufficiale OCV dei numeri all'asta (PDF su ge.ch), con la
 * finestra della sessione e nessun prezzo. Parser e scoperta della lista sono
 * in functions/src/plateAuctionsCore.js, condivisi con la Cloud Function.
 * Ricardo, dove si offre, resta solo un link e non viene mai richiesto.
 */
import {
  fetchGePlateAuctions as fetchGeAuctionList,
  GE_PLATE_AUCTION_SOURCE,
  parseGePlateAuctionListPdfText,
} from '../../../functions/src/plateAuctionsCore.js';

export { GE_PLATE_AUCTION_SOURCE, parseGePlateAuctionListPdfText };

export async function fetchGePlateAuctions({ now = new Date(), injectedFetcher } = {}) {
  return fetchGeAuctionList({ fetchedAt: now.toISOString(), now, injectedFetcher });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchGePlateAuctions()
    .then((auctions) => {
      console.log(JSON.stringify(auctions, null, 2));
      console.log(`\n${auctions.length} GE listing(s) from the newest OCV list.`);
    })
    .catch((error) => {
      console.error('GE plate-auction fetch failed:', error);
      process.exitCode = 1;
    });
}
