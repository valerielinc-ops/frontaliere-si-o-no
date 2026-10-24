// Explicit declaration for intentional noindex pharmacy pages.
//
// pharmacyDirectoryPagesPlugin keeps three families crawlable but out of the
// index on purpose, each covered by its own test: city "on duty" aliases (the
// body repeats the regional OFCT rotation — tests/pharmacy-duty-city-aliases),
// closed duty weeks kept as a transparency archive (#13895 —
// tests/pharmacy-duty-week-history-seo) and duty pages whose data release is
// not verified yet (Italian provinces, the Ticino coverage matrix —
// tests/pharmacy-italy-duty-seo). validate-page-seo checks every pharmacy
// directory exhaustively and blocks on noindex; without a declaration it cannot
// tell these from an accidental noindex (336 of the 858 "noindex" errors of
// replay 39952023039). Same contract as jobBoardNoindexTargetMarker.mjs: the
// producer declares, the validators read one shared literal.
export const PHARMACY_NOINDEX_TARGET_MARKER = '<!--PHARMACY_NOINDEX_TARGET-->';
