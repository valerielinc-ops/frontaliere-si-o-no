// Evidence-layer tunable constants.
// Centralised so Phase 2+ scoring code reads from one source.

export const DEFAULT_WINDOW_DAYS = 90;

// Orphan query criteria (GSC queries with traffic potential but missing
// landing-page conversion).
export const ORPHAN_MIN_IMP = 100;
export const ORPHAN_MIN_POS = 10;
export const ORPHAN_MAX_CTR = 0.02;

// GSC noise floor — keys with fewer impressions than this are dropped.
export const GSC_MIN_IMP = 5;

// GA4 noise floor — pages with fewer sessions than this are dropped.
export const GA4_MIN_SESSIONS = 3;

// Minimum cluster sample size before we trust its percentiles.
export const CLUSTER_MIN_N = 5;

// Articles must have ramped (≥14 days old) before they enter cluster stats.
export const CLUSTER_RAMPUP_DAYS = 14;

// Site URL used by GSC fetcher (sc-domain property).
export const SITE_DOMAIN = 'frontaliereticino.ch';
export const SITE_URL = `https://${SITE_DOMAIN}/`;

// Embedding model — locked to one provider, picked at implementation time.
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM = 1536;
