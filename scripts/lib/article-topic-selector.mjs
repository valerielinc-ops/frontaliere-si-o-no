// scripts/lib/article-topic-selector.mjs
//
// Helpers for the smarter article generator (Phase 3 — Generator integration).
// Spec: docs/superpowers/specs/2026-05-06-smarter-article-generator-design.md
//
// Two responsibilities, both pure and independently testable:
//
//  1. Load `data/article-performance.json` + `data/topic-candidates.json` if
//     they exist. Missing files are NOT an error — generator behavior must
//     be byte-identical to today when both files are absent.
//
//  2. Select the next topic-candidate to generate from. The candidate pool
//     is consulted between the news pool and the evergreen pool:
//
//        news (high score) → top-candidate (score ≥ 0.6) → evergreen
//
//     `pickTopCandidate` skips candidates already in the consumed tracker
//     (`data/topic-candidates-consumed.json`) and skips candidates whose
//     keyword is structurally similar (Jaccard ≥ 0.7) to an existing IT
//     article title — defense in depth on top of Phase 1B novelty check.
//
//  3. Build a system-prompt string from the winner-fingerprint, in Italian,
//     to inject as additional system context in the LLM prompt. Returns
//     null when fingerprint is missing/empty so the caller can skip
//     injection cleanly (preserves byte-identical prompts).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  FRONTALIERI_DOMAIN_RE,
  isFrontalieriDomainTerm,
} from './perf-sources/domainTerms.mjs';
import {
  CLUSTER_TAXONOMY,
  buildClusterClassifierPrompt,
  classifyByRegex,
} from './cluster-classifier-prompt.mjs';

// ── Paths (overridable via opts for tests) ─────────────────────
export const PERFORMANCE_PATH = 'data/article-performance.json';
export const CANDIDATES_PATH = 'data/topic-candidates.json';
export const CONSUMED_PATH = 'data/topic-candidates-consumed.json';
export const DEMAND_VOCAB_PATH = 'data/demand-vocabulary.json';
export const EXPERIMENTAL_CANDIDATES_PATH = 'data/experimental-candidates.json';
export const EXPERIMENTAL_COUNTER_PATH = 'data/topic-candidates-experimental-counter.json';
export const TODAY_PICKS_BY_CLUSTER_PATH = 'data/topic-candidates-today-picks.json';

// Score floor for ranker output. Below this we fall back to evergreen.
export const RANKER_MIN_SCORE = 0.15;

// Default fraction of picks routed to the experimental tier.
export const EXPERIMENTAL_RATIO_DEFAULT = 0.10;

// Scoring weights — per design doc.
export const SCORE_WEIGHT_DEMAND = 0.6;
export const SCORE_WEIGHT_DIVERSITY = 0.2;
export const SCORE_WEIGHT_NOVELTY = 0.2;

// Headline-vs-existing-title novelty Jaccard threshold.
export const NOVELTY_DUP_JACCARD = 0.7;

// Cap retention on consumed tracker. Older IDs rotate out (FIFO).
export const CONSUMED_MAX_IDS = 500;

// Score threshold for picking a topic-candidate over the evergreen pool.
export const CANDIDATE_MIN_SCORE = 0.6;

// Jaccard threshold for "structurally similar to existing article".
// Defense in depth on top of Phase 1B novelty check.
export const CANDIDATE_DUP_JACCARD = 0.7;

// ── Safe JSON loader ───────────────────────────────────────────
export function loadJsonSafe(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    console.warn(`[generator] could not load ${path}: ${e.message}`);
    return null;
  }
}

// ── Tokenization + Jaccard (consistent with topic-sources) ─────
export function tokenize(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t && t.length >= 2),
  );
}

export function jaccardSimilarity(a, b) {
  const ta = a instanceof Set ? a : tokenize(a);
  const tb = b instanceof Set ? b : tokenize(b);
  if (ta.size === 0 && tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ── Existing-titles extractor (mirrors gscOrphans.extractItTitles) ─
const TITLE_RE = /'blog\.article\.[^.]+\.title':\s*'([^']+)'/g;

export function extractItTitlesFromMeta(metaSrc) {
  if (!metaSrc) return [];
  const out = [];
  for (const m of metaSrc.matchAll(TITLE_RE)) {
    out.push(m[1]);
  }
  return out;
}

export function loadExistingItTitles(metaPath = 'services/locales/blog-meta-it.ts') {
  try {
    if (!existsSync(metaPath)) return [];
    return extractItTitlesFromMeta(readFileSync(metaPath, 'utf-8'));
  } catch (e) {
    console.warn(`[generator] could not load IT titles from ${metaPath}: ${e.message}`);
    return [];
  }
}

// ── Candidate-vs-existing duplicate check ──────────────────────
export function isCandidateDuplicate(candidate, existingTitles, threshold = CANDIDATE_DUP_JACCARD) {
  if (!candidate || !candidate.keyword) return false;
  if (!Array.isArray(existingTitles) || existingTitles.length === 0) return false;
  const kwTokens = tokenize(candidate.keyword);
  for (const title of existingTitles) {
    if (jaccardSimilarity(kwTokens, tokenize(title)) >= threshold) return true;
  }
  return false;
}

// ── Consumed tracker ────────────────────────────────────────────
export function loadConsumedTracker(path = CONSUMED_PATH) {
  const raw = loadJsonSafe(path);
  if (!raw || typeof raw !== 'object') {
    return { consumedAt: null, ids: [] };
  }
  return {
    consumedAt: typeof raw.consumedAt === 'string' ? raw.consumedAt : null,
    ids: Array.isArray(raw.ids) ? raw.ids.filter((x) => typeof x === 'string') : [],
  };
}

export function appendConsumedId(tracker, id, max = CONSUMED_MAX_IDS) {
  if (!id) return tracker;
  const ids = (tracker?.ids || []).filter((x) => x !== id);
  ids.push(id);
  // FIFO rotation: drop oldest entries beyond the cap.
  while (ids.length > max) ids.shift();
  return { consumedAt: new Date().toISOString(), ids };
}

export function persistConsumedTracker(tracker, path = CONSUMED_PATH) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(tracker, null, 2) + '\n', 'utf-8');
    return true;
  } catch (e) {
    console.warn(`[generator] could not write consumed tracker to ${path}: ${e.message}`);
    return false;
  }
}

// ── Top candidate picker ───────────────────────────────────────
/**
 * Return the highest-scoring candidate that is:
 *  - not already in the consumed tracker
 *  - has totalScore ≥ minScore (default 0.6)
 *  - not structurally similar to an existing IT article title
 *
 * @param {object|null} topicCandidates - parsed data/topic-candidates.json or null
 * @param {object} opts
 * @param {object} [opts.consumed] - tracker object { ids: [] }
 * @param {string[]} [opts.existingTitles] - list of existing IT article titles
 * @param {number} [opts.minScore=0.6]
 * @returns {object|null} candidate or null
 */
export function pickTopCandidate(topicCandidates, opts = {}) {
  const list = topicCandidates?.candidates;
  if (!Array.isArray(list) || list.length === 0) return null;
  const consumedIds = new Set(opts.consumed?.ids || []);
  const minScore = typeof opts.minScore === 'number' ? opts.minScore : CANDIDATE_MIN_SCORE;
  const existingTitles = Array.isArray(opts.existingTitles) ? opts.existingTitles : [];
  for (const cand of list) {
    if (!cand || !cand.id || !cand.keyword) continue;
    if (consumedIds.has(cand.id)) continue;
    if (typeof cand.totalScore !== 'number' || cand.totalScore < minScore) continue;
    if (isCandidateDuplicate(cand, existingTitles)) continue;
    return cand;
  }
  return null;
}

// ── Winner-fingerprint → system-prompt string ──────────────────
function arr(v) {
  return Array.isArray(v) ? v.filter((x) => x != null && x !== '') : [];
}

// `FRONTALIERI_DOMAIN_RE` + `isFrontalieriDomainTerm` are now imported from
// `./perf-sources/domainTerms.mjs` so producer (fetch-article-performance)
// and consumer (this module) agree on the allowlist.
export { FRONTALIERI_DOMAIN_RE, isFrontalieriDomainTerm };

/**
 * Build the Italian system-message string from a winner fingerprint.
 * Returns null when the fingerprint has no usable content — caller
 * MUST skip injection in that case to preserve byte-identical prompts
 * vs today's behavior.
 */
export function buildWinnerFingerprintMessage(perf) {
  const fp = perf?.winnerFingerprint;
  if (!fp || typeof fp !== 'object') return null;

  const clusters = arr(fp.topClusters)
    .map((c) => (typeof c === 'string' ? c : c?.cluster))
    .filter(Boolean)
    // QUALITY GATE: drop the placeholder "unknown" cluster — happens when the
    // fingerprint can't resolve articleSection from blog-meta and falls back
    // to a single-bucket [{cluster:"unknown",weight:1.0}]. Injecting "unknown"
    // into the LLM prompt is misleading.
    .filter((c) => c.toLowerCase() !== 'unknown');
  const angles = arr(fp.topAngles);
  const keywords = arr(fp.topKeywords)
    // QUALITY GATE: only keep keywords that look frontalieri-domain. The
    // current TF-IDF over winner titles surfaces news-of-day words (angeli,
    // grandine, pastori) that have nothing to do with cross-border work and
    // would actively pollute the LLM prompt. Allowlist regex matches the
    // evergreen domain vocabulary; stricter and noisier than precision-only
    // ranking, but safe.
    .filter((k) => isFrontalieriDomainTerm(k));
  const questionPatterns = arr(fp.topQuestionPatterns);
  const wordCount = typeof fp.averageWordCount === 'number' && fp.averageWordCount > 0
    ? Math.round(fp.averageWordCount)
    : null;

  // If literally nothing useful is present, skip injection.
  if (
    clusters.length === 0
    && angles.length === 0
    && keywords.length === 0
    && questionPatterns.length === 0
    && wordCount == null
  ) {
    return null;
  }

  const lines = ['Per riferimento, gli articoli con più traffico organico storicamente:'];
  if (clusters.length) lines.push(`- coprono questi cluster: ${clusters.join(', ')}`);
  if (angles.length) lines.push(`- usano angoli concreti tipo: ${angles.join('; ')}`);
  if (keywords.length) lines.push(`- includono parole chiave: ${keywords.join(', ')}`);
  if (wordCount != null) lines.push(`- hanno una lunghezza media di ~${wordCount} parole`);
  if (questionPatterns.length) lines.push(`- rispondono spesso a domande tipo: ${questionPatterns.join(', ')}`);
  lines.push('');
  lines.push('Mantieni questi pattern QUANDO sono pertinenti al topic in input. Non');
  lines.push('forzarli se il topic non li richiede.');

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// Phase B + C — News-pool re-ranker + experimental tier
// ═══════════════════════════════════════════════════════════════════
//
// The news-RSS scan is the *content pool*. The demand-vocabulary
// (GSC + Suggest + winnerFingerprint) is the *scoring signal*. Goal:
// pick the headline with the strongest demand-overlap, NOT the first
// one returned by the scan, and rotate clusters across the day so we
// don't publish 16 fiscale articles in a row.
//
// `rankAndSelectHeadlines` is the orchestrator. Pure(-ish): the only
// non-deterministic input is the experimental-counter file, which the
// caller is responsible for persisting AFTER successful generation.

// ── Demand-vocabulary + experimental loaders ───────────────────────
/**
 * Load `data/demand-vocabulary.json`. Returns null when missing so the
 * caller can gracefully fall back to evergreen / legacy selection.
 *
 * @param {{path?: string}} [opts]
 * @returns {object|null}
 */
export function loadDemandVocabulary(opts = {}) {
  const path = (opts && opts.path) || DEMAND_VOCAB_PATH;
  return loadJsonSafe(path);
}

/**
 * Load `data/experimental-candidates.json`. Same shape as the legacy
 * `topic-candidates.json` but only Reddit + News-RSS sources. Returns
 * null when missing.
 *
 * @param {{path?: string}} [opts]
 * @returns {object|null}
 */
export function loadExperimentalCandidates(opts = {}) {
  const path = (opts && opts.path) || EXPERIMENTAL_CANDIDATES_PATH;
  return loadJsonSafe(path);
}

// ── Cluster classification (LLM batch + regex fallback) ────────────

const CLUSTER_TAXONOMY_SET = new Set(CLUSTER_TAXONOMY);

/**
 * Validate the LLM cluster-classifier response. Returns an array of
 * length `expectedLength`: each entry is either the LLM-provided
 * cluster (when valid) or `null` so the caller can fill from
 * `classifyByRegex` per-headline.
 *
 * Defensive — never throws on malformed input.
 *
 * @param {unknown} parsed
 * @param {number} expectedLength
 * @returns {(string|null)[]}
 */
function coerceClusterArray(parsed, expectedLength) {
  if (!Array.isArray(parsed)) return new Array(expectedLength).fill(null);
  // If length doesn't match, signal full fallback.
  if (parsed.length !== expectedLength) {
    return new Array(expectedLength).fill(null);
  }
  return parsed.map((entry) => {
    if (typeof entry !== 'string') return null;
    const trimmed = entry.trim().toLowerCase();
    return CLUSTER_TAXONOMY_SET.has(trimmed) ? trimmed : null;
  });
}

/**
 * Strip Markdown code fences, leading prose, and `<think>` blocks
 * from an LLM response so JSON.parse stands a chance.
 */
function stripFenceAndPrefix(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  // Strip <think>...</think> reasoning blocks (DeepSeek-R1 etc.).
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Strip ```json fences.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // Find first '[' so prose like "Here is the array: [...]" still parses.
  const bracketIdx = s.indexOf('[');
  if (bracketIdx > 0) s = s.slice(bracketIdx);
  return s;
}

/**
 * Batch-classify cluster for an array of headline strings via the LLM
 * cluster (`callLLM` from `ai-models.mjs`) with a regex defense-in-depth
 * fallback.
 *
 * Contract: returns `Promise<string[]>` of length === headlines.length,
 * each value from CLUSTER_TAXONOMY.
 *
 * Failure modes (all graceful):
 *  - empty input → []
 *  - opts.forceRegex === true → pure regex path (no LLM call)
 *  - LLM throws (all providers exhausted) → regex per headline
 *  - LLM returns malformed JSON → regex per headline
 *  - LLM returns wrong-length array → regex per headline
 *  - LLM returns array with N hallucinated entries → regex only those N
 *
 * @param {string[]} headlines
 * @param {{forceRegex?: boolean, callLLM?: Function, model?: string}} [opts]
 * @returns {Promise<string[]>}
 */
export async function classifyHeadlineClusters(headlines, opts = {}) {
  const list = Array.isArray(headlines) ? headlines : [];
  if (list.length === 0) return [];

  // Test seam — bypass LLM entirely.
  if (opts && opts.forceRegex === true) {
    return list.map((h) => classifyByRegex(String(h ?? '')));
  }

  // Lazy-import ai-models so unit tests can keep the file mock-light.
  let callLLM = opts && opts.callLLM;
  if (typeof callLLM !== 'function') {
    try {
      const mod = await import('./ai-models.mjs');
      callLLM = mod.callLLM;
    } catch (e) {
      console.warn(`[generator] ai-models import failed, regex fallback: ${e?.message || e}`);
      return list.map((h) => classifyByRegex(String(h ?? '')));
    }
  }

  const prompt = buildClusterClassifierPrompt(list);
  const messages = [
    { role: 'system', content: 'Sei un classificatore preciso. Rispondi SOLO con un array JSON, niente altro.' },
    { role: 'user', content: prompt },
  ];

  let raw;
  try {
    raw = await callLLM(messages, {
      temperature: 0,
      maxTokens: Math.min(1024, 32 + list.length * 16),
      jsonMode: true,
      ...(opts.model ? { model: opts.model } : {}),
    });
  } catch (e) {
    console.warn(`[generator] cluster classifier LLM failed, regex fallback: ${e?.message || e}`);
    return list.map((h) => classifyByRegex(String(h ?? '')));
  }

  let parsed;
  try {
    parsed = JSON.parse(stripFenceAndPrefix(typeof raw === 'string' ? raw : raw?.content || ''));
  } catch {
    console.warn('[generator] cluster classifier returned malformed JSON, regex fallback');
    return list.map((h) => classifyByRegex(String(h ?? '')));
  }

  const coerced = coerceClusterArray(parsed, list.length);
  // If every entry is null we degraded fully — log once.
  const nullCount = coerced.reduce((acc, v) => acc + (v == null ? 1 : 0), 0);
  if (nullCount === list.length) {
    console.warn('[generator] cluster classifier output rejected (length mismatch or no valid entries), regex fallback');
  } else if (nullCount > 0) {
    console.warn(`[generator] cluster classifier: ${nullCount}/${list.length} entries fell back to regex`);
  }

  return coerced.map((cluster, i) => cluster ?? classifyByRegex(String(list[i] ?? '')));
}

// ── Headline scoring ───────────────────────────────────────────────

/**
 * Compute the total weighted demand score of a headline against the
 * stable demand vocabulary. Pure function.
 *
 * For each vocab keyword, multiplies the per-keyword Jaccard similarity
 * (headline tokens vs keyword tokens) by the keyword weight, then sums.
 *
 * @param {string} headline
 * @param {{stableKeywords?: Array}} vocab
 * @returns {number} demandScore in [0, ~weight_sum]
 */
function computeDemandScore(headline, vocab) {
  if (!vocab || !Array.isArray(vocab.stableKeywords) || vocab.stableKeywords.length === 0) {
    return 0;
  }
  const headlineTokens = tokenize(headline);
  if (headlineTokens.size === 0) return 0;
  let total = 0;
  for (const kw of vocab.stableKeywords) {
    if (!kw || !kw.kw) continue;
    const weight = typeof kw.weight === 'number' ? kw.weight : 0;
    if (weight <= 0) continue;
    const sim = jaccardSimilarity(headlineTokens, tokenize(kw.kw));
    total += sim * weight;
  }
  return total;
}

/**
 * Cluster diversity bonus — first pick of a cluster today gets 1.0,
 * each subsequent pick halves: 0.5 → 0.25 → 0.125 → ...
 *
 * @param {string} cluster
 * @param {Record<string, number>} todayPicksByCluster
 * @returns {number}
 */
function computeClusterDiversityBonus(cluster, todayPicksByCluster) {
  if (!cluster) return 0;
  const picks = (todayPicksByCluster && todayPicksByCluster[cluster]) || 0;
  if (picks <= 0) return 1.0;
  return Math.pow(0.5, picks);
}

/**
 * Novelty bonus: 1.0 when the headline's max Jaccard with any
 * existing IT title is < NOVELTY_DUP_JACCARD; otherwise 0.
 *
 * @param {string} headline
 * @param {string[]} existingTitles
 * @returns {number}
 */
function computeNoveltyScore(headline, existingTitles) {
  if (!Array.isArray(existingTitles) || existingTitles.length === 0) return 1.0;
  const tokens = tokenize(headline);
  for (const title of existingTitles) {
    if (jaccardSimilarity(tokens, tokenize(title)) >= NOVELTY_DUP_JACCARD) {
      return 0;
    }
  }
  return 1.0;
}

/**
 * Pure scoring of a single headline against the demand vocabulary.
 *
 * Returns a breakdown object so the caller can log which signals
 * fired. Total score is a weighted sum of:
 *   - demandScore (60%)
 *   - clusterDiversityBonus (20%)
 *   - noveltyScore (20%)
 *
 * @param {string} headline
 * @param {{stableKeywords?: Array}|null} vocab
 * @param {{
 *   todayPicksByCluster?: Record<string, number>,
 *   headlineCluster?: string,
 *   existingTitles?: string[],
 * }} [opts]
 * @returns {{score: number, demandScore: number, clusterDiversityBonus: number, noveltyScore: number, cluster: string}}
 */
export function scoreHeadline(headline, vocab, opts = {}) {
  const cluster = opts.headlineCluster || 'generic';
  const demandScore = computeDemandScore(headline, vocab || {});
  const clusterDiversityBonus = computeClusterDiversityBonus(cluster, opts.todayPicksByCluster || {});
  const noveltyScore = computeNoveltyScore(headline, opts.existingTitles || []);
  const score
    = SCORE_WEIGHT_DEMAND * demandScore
    + SCORE_WEIGHT_DIVERSITY * clusterDiversityBonus
    + SCORE_WEIGHT_NOVELTY * noveltyScore;
  return { score, demandScore, clusterDiversityBonus, noveltyScore, cluster };
}

// ── Today-picks-by-cluster persistence ────────────────────────────

function ymdUtc(now) {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Read the per-day picks-by-cluster counter. Resets to all zeros when
 * the persisted date doesn't match today (UTC).
 *
 * @param {Date|number|string} [now]
 * @param {{path?: string}} [opts]
 */
export function loadTodayPicksByCluster(now = Date.now(), opts = {}) {
  const path = (opts && opts.path) || TODAY_PICKS_BY_CLUSTER_PATH;
  const raw = loadJsonSafe(path);
  const today = ymdUtc(now);
  const empty = {};
  for (const c of CLUSTER_TAXONOMY) empty[c] = 0;
  if (!raw || typeof raw !== 'object' || raw.date !== today) {
    return { date: today, picksByCluster: empty };
  }
  const picksByCluster = { ...empty };
  if (raw.picksByCluster && typeof raw.picksByCluster === 'object') {
    for (const c of CLUSTER_TAXONOMY) {
      const v = raw.picksByCluster[c];
      if (typeof v === 'number' && v >= 0) picksByCluster[c] = v;
    }
  }
  return { date: today, picksByCluster };
}

/**
 * Atomically persist the today-picks-by-cluster counter.
 * Same on-disk pattern as `persistConsumedTracker`.
 *
 * @param {{date?: string, picksByCluster: Record<string, number>}} state
 * @param {Date|number|string} [now]
 * @param {{path?: string}} [opts]
 */
export function persistTodayPicksByCluster(state, now = Date.now(), opts = {}) {
  const path = (opts && opts.path) || TODAY_PICKS_BY_CLUSTER_PATH;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const out = {
      date: (state && state.date) || ymdUtc(now),
      picksByCluster: (state && state.picksByCluster) || {},
    };
    writeFileSync(path, JSON.stringify(out, null, 2) + '\n', 'utf-8');
    return true;
  } catch (e) {
    console.warn(`[generator] could not write today-picks tracker to ${path}: ${e.message}`);
    return false;
  }
}

// ── Experimental-tier counter (pseudo-deterministic 1-in-N) ───────

/**
 * Read the experimental-tier round-robin counter. Missing/malformed
 * file yields `{ count: 0 }`.
 *
 * @param {{path?: string}} [opts]
 */
export function loadExperimentalCounter(opts = {}) {
  const path = (opts && opts.path) || EXPERIMENTAL_COUNTER_PATH;
  const raw = loadJsonSafe(path);
  if (!raw || typeof raw !== 'object' || typeof raw.count !== 'number' || raw.count < 0) {
    return { count: 0 };
  }
  return { count: Math.floor(raw.count) };
}

/**
 * Persist the experimental-tier counter.
 *
 * @param {{count: number}} state
 * @param {{path?: string}} [opts]
 */
export function persistExperimentalCounter(state, opts = {}) {
  const path = (opts && opts.path) || EXPERIMENTAL_COUNTER_PATH;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ count: Math.max(0, Math.floor(state?.count || 0)) }, null, 2) + '\n', 'utf-8');
    return true;
  } catch (e) {
    console.warn(`[generator] could not write experimental counter to ${path}: ${e.message}`);
    return false;
  }
}

/**
 * Decide whether the next pick should go to the experimental tier.
 * Round-robin: 1 in every (1/ratio) calls is experimental. With
 * default ratio=0.10 → 1-in-10.
 *
 * @param {number} count
 * @param {number} ratio
 * @returns {boolean}
 */
export function shouldUseExperimentalTier(count, ratio = EXPERIMENTAL_RATIO_DEFAULT) {
  if (!ratio || ratio <= 0) return false;
  if (ratio >= 1) return true;
  // count % bucket < (ratio*bucket) → ~ratio fraction true.
  const bucket = Math.max(2, Math.round(1 / ratio));
  const threshold = Math.max(1, Math.round(ratio * bucket));
  return ((Math.max(0, Math.floor(count)) % bucket) < threshold);
}

// ── Top-level orchestrator ────────────────────────────────────────

/**
 * Return the top experimental candidate that hasn't been consumed.
 * Used when the round-robin says "experimental tier this turn".
 */
function pickTopExperimentalCandidate(experimentalCandidates, opts = {}) {
  if (!experimentalCandidates || !Array.isArray(experimentalCandidates.candidates)) return null;
  const consumedIds = new Set((opts.consumed && opts.consumed.ids) || []);
  const existingTitles = Array.isArray(opts.existingTitles) ? opts.existingTitles : [];
  // Stable-sort by totalScore desc; preserve original order on tie.
  const ranked = experimentalCandidates.candidates
    .map((c, i) => ({ c, i, score: typeof c?.totalScore === 'number' ? c.totalScore : 0 }))
    .sort((a, b) => (b.score - a.score) || (a.i - b.i));
  for (const { c } of ranked) {
    if (!c || !c.id || !c.keyword) continue;
    if (consumedIds.has(c.id)) continue;
    if (isCandidateDuplicate(c, existingTitles)) continue;
    return c;
  }
  return null;
}

/**
 * Rank a news-pool of headlines against the demand vocabulary, optionally
 * route to the experimental tier per the round-robin counter, and return
 * the top-N picks (currently maxPicks=1 since create-article generates
 * one article per run).
 *
 * Returns an array (possibly empty). Each entry is the original headline
 * object (for stable picks) or experimental candidate (for experimental
 * picks), augmented with `_selectedSource`, `_score`, and `_cluster`
 * marker fields so the caller can log + persist counters.
 *
 * Empty result → caller falls back to evergreen.
 *
 * @param {Array} headlines  — headline objects from scanNewsSources
 * @param {object|null} vocab — parsed demand-vocabulary.json
 * @param {{
 *   experimentalCandidates?: object|null,
 *   maxPicks?: number,
 *   minScore?: number,
 *   experimentalRatio?: number,
 *   experimentalCounter?: number,
 *   forceExperimental?: boolean,
 *   classifierOpts?: object,
 *   todayPicksByCluster?: Record<string, number>,
 *   existingTitles?: string[],
 *   consumed?: {ids: string[]},
 *   headlineTitleField?: string,
 * }} [opts]
 * @returns {Promise<Array>}
 */
export async function rankAndSelectHeadlines(headlines, vocab, opts = {}) {
  const list = Array.isArray(headlines) ? headlines : [];
  const titleField = opts.headlineTitleField || 'headline';
  const minScore = typeof opts.minScore === 'number' ? opts.minScore : RANKER_MIN_SCORE;
  const maxPicks = typeof opts.maxPicks === 'number' && opts.maxPicks > 0 ? Math.floor(opts.maxPicks) : 1;
  const ratio = typeof opts.experimentalRatio === 'number' ? opts.experimentalRatio : EXPERIMENTAL_RATIO_DEFAULT;

  // Experimental tier decision (round-robin or forced).
  const counterValue = typeof opts.experimentalCounter === 'number' ? opts.experimentalCounter : 0;
  const goExperimental = opts.forceExperimental === true
    || (opts.experimentalCandidates && shouldUseExperimentalTier(counterValue, ratio));

  if (goExperimental && opts.experimentalCandidates) {
    const exp = pickTopExperimentalCandidate(opts.experimentalCandidates, {
      consumed: opts.consumed,
      existingTitles: opts.existingTitles,
    });
    if (exp) {
      // Augment with selection markers (don't mutate original).
      return [{ ...exp, _selectedSource: 'experimental', _score: null, _cluster: exp.cluster || null }];
    }
    // If experimental pool empty/exhausted, fall through to stable scoring
    // rather than failing — better to publish than to skip.
  }

  if (list.length === 0) return [];

  const titles = list.map((h) => String((h && h[titleField]) ?? h?.title ?? ''));
  const clusters = await classifyHeadlineClusters(titles, opts.classifierOpts || {});

  const scored = list.map((h, i) => {
    const headlineText = titles[i];
    const breakdown = scoreHeadline(headlineText, vocab, {
      todayPicksByCluster: opts.todayPicksByCluster || {},
      headlineCluster: clusters[i] || 'generic',
      existingTitles: opts.existingTitles || [],
    });
    return { headline: h, breakdown, index: i };
  });

  // Sort desc by score; preserve original order on tie.
  scored.sort((a, b) => (b.breakdown.score - a.breakdown.score) || (a.index - b.index));

  const picks = [];
  for (const { headline, breakdown } of scored) {
    if (breakdown.score < minScore) break;
    picks.push({
      ...headline,
      _selectedSource: 'stable',
      _score: breakdown,
      _cluster: breakdown.cluster,
    });
    if (picks.length >= maxPicks) break;
  }
  return picks;
}

export default {
  PERFORMANCE_PATH,
  CANDIDATES_PATH,
  CONSUMED_PATH,
  CONSUMED_MAX_IDS,
  CANDIDATE_MIN_SCORE,
  CANDIDATE_DUP_JACCARD,
  DEMAND_VOCAB_PATH,
  EXPERIMENTAL_CANDIDATES_PATH,
  EXPERIMENTAL_COUNTER_PATH,
  TODAY_PICKS_BY_CLUSTER_PATH,
  RANKER_MIN_SCORE,
  EXPERIMENTAL_RATIO_DEFAULT,
  SCORE_WEIGHT_DEMAND,
  SCORE_WEIGHT_DIVERSITY,
  SCORE_WEIGHT_NOVELTY,
  NOVELTY_DUP_JACCARD,
  loadJsonSafe,
  tokenize,
  jaccardSimilarity,
  extractItTitlesFromMeta,
  loadExistingItTitles,
  isCandidateDuplicate,
  loadConsumedTracker,
  appendConsumedId,
  persistConsumedTracker,
  pickTopCandidate,
  buildWinnerFingerprintMessage,
  loadDemandVocabulary,
  loadExperimentalCandidates,
  classifyHeadlineClusters,
  scoreHeadline,
  loadTodayPicksByCluster,
  persistTodayPicksByCluster,
  loadExperimentalCounter,
  persistExperimentalCounter,
  shouldUseExperimentalTier,
  rankAndSelectHeadlines,
};
