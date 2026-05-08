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

// Embedding model — chained provider fallback (Mistral → Cohere → OpenAI).
// Default is Mistral (`mistral-embed`, 1024-dim, EU-hosted). Cohere
// `embed-multilingual-v3.0` shares 1024-dim so it can be a drop-in
// fallback. OpenAI `text-embedding-3-small` is 1536-dim — only used
// when both Mistral and Cohere keys are missing AND OPENAI_API_KEY is
// set; in that case the build script switches dim at runtime via the
// per-provider config below.
export const EMBEDDING_DIM = 1024;

// Provider chain: ordered preference. The first provider whose API key is
// present in env is used. The chain is consulted in order at every batch
// call (no caching of "selected provider" — adapt to env changes).
// `dim` MUST equal EMBEDDING_DIM for any provider used; OpenAI is excluded
// from the default chain because its dim differs.
export const EMBEDDING_PROVIDERS = [
  {
    id: 'mistral',
    model: 'mistral-embed',
    dim: 1024,
    url: 'https://api.mistral.ai/v1/embeddings',
    keyEnv: 'MISTRAL_API_KEY',
  },
  {
    id: 'cohere',
    model: 'embed-multilingual-v3.0',
    dim: 1024,
    // Cohere uses a v2/embed endpoint with a different request shape;
    // see embeddingClient.mjs for adapter logic.
    url: 'https://api.cohere.ai/v2/embed',
    keyEnv: 'COHERE_API_KEY',
  },
];

// Legacy export for backwards-compat with code that imports EMBEDDING_MODEL.
// Resolves to the model of the first available provider at runtime.
export const EMBEDDING_MODEL = 'mistral-embed';
