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

// Embeddings — LOCAL inference (no API keys / quota / rate limits).
//
// 2026-06-18: switched the whole embedding layer from the Mistral → Cohere →
// Gemini API chain to a local ONNX model run on the CI runner. Every free-tier
// API key had failed (Mistral 401, Cohere trial 1000/month spent, Gemini free
// 1000/day < the ~2700-article corpus), so a full re-embed could never complete
// and the store froze at 2642 → P1 B.6.embedding-store-outdated → "Quality
// alerts" main-red. `multilingual-e5-small` runs locally via
// @huggingface/transformers (onnxruntime) — embeds the whole corpus in one run,
// deterministic, free forever, no keys. See scripts/lib/evidence/embeddingClient.mjs.
//
// e5-small is 384-dim (was 1024 on the API providers). Switching the model is a
// different vector space → the build's model-drift detection forces a one-time
// full re-embed and the binary store is rebuilt at the new dim.
export const EMBEDDING_DIM = 384;

// HuggingFace model id for the local embedder. Weights download once from the
// public HF CDN (no key) and cache under .cache/transformers.
export const EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';

// Single local "provider". Kept as an array for compatibility with code/tests
// that introspect the chain; there are no keys or endpoints — inference is local.
export const EMBEDDING_PROVIDERS = [
  {
    id: 'local',
    model: EMBEDDING_MODEL,
    dim: EMBEDDING_DIM,
  },
];
