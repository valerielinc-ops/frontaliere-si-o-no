// scripts/lib/scoring/constants.mjs
//
// Tunable thresholds for cascaded scoring (Phase 2).
// Spec: docs/superpowers/specs/2026-05-07-traffic-quality-algorithm-design.md § 5

// GSC bridge — minimum daily-rate signal required to accept the GSC stage.
// gscScore is in "predicted sessions per day"; threshold is daily, then
// multiplied by 14 to get the article-horizon prediction.
export const GSC_MIN_SIGNAL = 5;

// Embedding stage — minimum cosine similarity required between the
// candidate headline and the closest published article. Below this the
// signal is too weak to trust embedding-based prediction.
export const EMBEDDING_MIN_COSINE = 0.4;

// Confidence multipliers per cascade stage. Final score = rawScore * confidence.
export const CONFIDENCE_GSC = 1.0;
export const CONFIDENCE_EMBEDDING = 0.8;
export const CONFIDENCE_CLUSTER = 0.3;

// Cluster fallback divisor for the `generic` cluster (penalises
// unclassifiable headlines). Applied BEFORE the confidence multiplier.
export const GENERIC_FLOOR_DIVISOR = 2;

// How many top-K articles the embedding stage uses to compute the
// quality-weighted prediction.
export const EMBEDDING_TOP_K = 5;

// Predicted-sessions horizon (days). Multiplied into the raw GSC daily rate
// to convert per-day signal into per-article prediction.
export const HORIZON_DAYS = 14;

// Position-decay used to discount predicted CTR for queries ranked deep in
// SERP. `posDecay = max(0.1, (11 - pos) / 10)`.
export const POS_DECAY_MIN = 0.1;
export const POS_DECAY_PIVOT = 11;

// Per-process LRU cache size for embedded headlines. Avoids re-embedding
// the same headline across multiple slot calls in the same Node process.
export const HEADLINE_EMBED_CACHE_SIZE = 200;

// Path to the binary embedding store produced by Phase 1's
// scripts/build-article-embeddings.mjs. Public so the matcher can read it
// without wiring a path through every call site.
export const ARTICLE_EMBEDDINGS_BIN_PATH = 'data/article-embeddings.bin';
export const ARTICLE_EMBEDDINGS_META_PATH = 'data/article-embeddings-meta.json';
export const EVIDENCE_INDEX_PATH = 'data/evidence-index.json';
