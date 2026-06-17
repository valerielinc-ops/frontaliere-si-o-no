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

// Embedding provider chain — Mistral → Cohere → Gemini fallback. All emit dim
// 1024 so the binary store format is provider-agnostic across the chain.
// Credentials come from Firebase Remote Config (MISTRAL_API_KEY,
// COHERE_API_KEY, GEMINI_API_KEY) via load-rc-env.mjs — no GitHub secrets.
//
// Gemini was added (2026-06-17) as the rescue tail: the Mistral key went 401
// (revoked) and Cohere was unset, so `embedBatch` exhausted the chain at request
// time and `build-article-embeddings.mjs` graceful-skipped every run — the
// embedding store froze at 2642 while live articles grew to 2698 (gap > 50),
// firing the P1 `B.6.embedding-store-outdated` quality alert (main went red on
// the daily "Quality alerts" monitor). `GEMINI_API_KEY` is the project's live
// free AI key (already used by build-evidence-index in the same workflow), so
// wiring Gemini embeddings restores the store without depending on a fresh
// Mistral/Cohere key. gemini-embedding-001 is a DIFFERENT vector space → the
// build's model-change detection triggers a one-time full re-embed.
export const EMBEDDING_DIM = 1024;

// Provider chain: ordered preference. Every provider whose API key is present
// is tried in order at request time; a provider that FAILS (401/429/5xx) falls
// through to the next. `dim` MUST equal EMBEDDING_DIM for any provider used.
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
  {
    id: 'gemini',
    // gemini-embedding-001 emits 3072 dims natively; outputDimensionality=1024
    // (MRL truncation) matches the store. Truncated dims (<3072) are NOT
    // unit-norm from the API → the adapter L2-normalizes (Google guidance).
    model: 'gemini-embedding-001',
    dim: 1024,
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
    keyEnv: 'GEMINI_API_KEY',
  },
];

// Legacy export for backwards-compat with code that imports EMBEDDING_MODEL.
// Resolves to the model of the first available provider at runtime.
export const EMBEDDING_MODEL = 'mistral-embed';
