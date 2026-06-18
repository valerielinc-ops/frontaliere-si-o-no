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
//
// Holds under the query:/passage: asymmetric encoding (scoreFromEmbedding
// now query-encodes the headline). multilingual-e5-small concentrates
// cosines in a high band (~0.7-0.95 for related text) in BOTH the old
// passage-passage (symmetric) regime and the now-intended query-passage
// (asymmetric) retrieval regime. The asymmetric switch can shift the
// absolute band down modestly (short query vs longer passage), but it
// stays far above this 0.4 "too weak to trust" floor — so the gate does
// not bind in either regime and the encoding change does not move its
// behaviour. 0.4 is a deliberately loose noise floor, not a precision
// threshold tuned to the symmetric distribution; it is NOT re-tuned here.
export const EMBEDDING_MIN_COSINE = 0.4;

// Semantic near-duplicate ceiling (2026-05-30). The lexical Jaccard gates
// in create-article.mjs (`checkForDuplicates`) miss articles that re-tell
// the SAME story with different vocabulary — e.g. "Aumento salari Svizzera
// 2024" vs "Aumenti salariali Ticino 2025" share ~0 title tokens yet sit
// at cosine 0.876. When a candidate's title+excerpt embedding is at or
// above this cosine to an already-published article, it's a near-duplicate
// and is rejected pre-publish. Tunable via env NEAR_DUP_COSINE; degrades
// to a no-op when the embedding store is missing or the API call fails.
export const EMBEDDING_NEAR_DUP_COSINE = Math.min(
  1,
  Math.max(
    EMBEDDING_MIN_COSINE,
    Number.parseFloat(process.env.NEAR_DUP_COSINE || '0.86') || 0.86,
  ),
);

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
