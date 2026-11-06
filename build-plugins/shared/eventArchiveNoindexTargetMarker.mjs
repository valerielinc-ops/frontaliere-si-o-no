// Explicit declaration for the intentional noindex municipal event archives.
//
// eventsSeoPagesPlugin keeps every municipal archive (/<section>/<canton>/
// <comune>/archivio/ and its locale twins) out of search and sitemaps on
// purpose: they list events that already happened, not current availability
// (renderHistoricalArchivePage). ~2,440 such pages across the four locales.
// validate-page-seo blocks on any noindex it cannot attribute; this marker is
// the producer's declaration, read through one shared literal — the same
// contract as jobBoardNoindexTargetMarker.mjs and
// pharmacyNoindexTargetMarker.mjs. A NATIONAL archive that is noindex because
// it fell below the word floor gets no marker and stays a visible defect.
export const EVENT_ARCHIVE_NOINDEX_TARGET_MARKER = '<!--EVENT_ARCHIVE_NOINDEX_TARGET-->';
