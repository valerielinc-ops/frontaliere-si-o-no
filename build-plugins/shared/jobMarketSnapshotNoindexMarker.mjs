// Explicit declaration for completed weekly snapshots outside the indexable
// window.  They stay reachable and self-canonical, but are intentionally
// noindex/follow once they become historical.
export const JOB_MARKET_SNAPSHOT_NOINDEX_MARKER = '<!--JOB_MARKET_SNAPSHOT_NOINDEX-->';
