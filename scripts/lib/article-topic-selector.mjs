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
// Empirical 2026-05-07: top scores are 1.4-1.5, demand 1.0-2.0. Min
// 0.15 was too permissive — borderline news with weak demand-signal
// passed when no high-quality headline was available. Bumped to 0.25
// to drop the bottom-quartile noise; on slow news days the existing
// evergreen fallback fills the gap with high-quality LLM-generated
// long-tail content instead of a borderline news article.
export const RANKER_MIN_SCORE = 0.25;

// Hard cap on picks per cluster per day (output-level diversity guard).
// Diversity bonus alone (soft signal) can be overruled by a strong
// demand-signal headline — e.g. picksByCluster.generic=13 in a single
// day means 56% of output collapsed into one cluster. This cap forces
// the ranker to skip headlines whose cluster has reached the limit.
//
// Cadence: generate-article runs every 15min → ~96 articles/day. Cap at
// 25 ≈ 26% of daily output. Leaves room for legitimate generic dominance
// (regional news IS mostly generic) while preventing 80%+ collapse.
// Override via env RANKER_MAX_PER_CLUSTER for slow-news days or when
// editorial wants to force a specific tier.
export const RANKER_MAX_PER_CLUSTER = Math.max(
  1,
  Number.parseInt(process.env.RANKER_MAX_PER_CLUSTER || '25', 10) || 25,
);

// Default fraction of picks routed to the experimental tier.
export const EXPERIMENTAL_RATIO_DEFAULT = 0.10;

// Default fraction of articles forced to the evergreen path (vs news
// scan). 0.30 = ~1 evergreen every 3 articles. Evergreen articles are
// generated directly from winnerFingerprint.topKeywords + the
// PRIORITY_EVERGREEN_TOPICS pool — high-monetization, long-tail SEO,
// not dependent on news pool composition. 2026-05-07: introduced after
// observing news pool was 81% generic regional cronaca; this guarantees
// 30% of output is on evergreen high-value topics regardless of news.
export const EVERGREEN_QUOTA_DEFAULT = 0.30;
export const EVERGREEN_COUNTER_PATH = 'data/topic-candidates-evergreen-counter.json';

// Scoring weights — per design doc.
export const SCORE_WEIGHT_DEMAND = 0.6;
export const SCORE_WEIGHT_DIVERSITY = 0.2;
export const SCORE_WEIGHT_NOVELTY = 0.2;

// Headline-vs-existing-title novelty Jaccard threshold.
export const NOVELTY_DUP_JACCARD = 0.7;

// Source-quality multiplier bounds (2026-05-07). Applied to a headline's
// final ranker score based on the historical winner-rate of its source
// domain. Domains with above-median winner rate get up to 1.5x boost;
// below-median get down to 0.5x. Self-strengthening loop: sources that
// produce winners get prioritized; sources whose articles never win get
// deprioritized — without categorical filtering.
export const SOURCE_QUALITY_MIN_MULTIPLIER = 0.5;
export const SOURCE_QUALITY_MAX_MULTIPLIER = 1.5;

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
  // Accept both shapes 2026-05-07:
  //   1. Top-level array: ["fiscale","salute",...]
  //   2. Object wrapping: {"clusters": [...]} (forced by jsonMode in
  //      OpenAI-compatible providers — top-level arrays are not allowed
  //      with response_format=json_object).
  // If parsed is an object, look for the first array-valued property.
  let arr = parsed;
  if (!Array.isArray(arr) && arr && typeof arr === 'object') {
    if (Array.isArray(arr.clusters)) {
      arr = arr.clusters;
    } else {
      // Tolerant: pick first array-valued key (handles models that wrap
      // under "result" / "categories" / "data" / etc.).
      for (const v of Object.values(arr)) {
        if (Array.isArray(v)) { arr = v; break; }
      }
    }
  }
  if (!Array.isArray(arr)) return new Array(expectedLength).fill(null);
  // 2026-05-07 graceful: if the array is SHORTER than expected (e.g.
  // recovered from a truncated LLM output), keep the prefix entries
  // and pad with nulls so the per-entry regex fallback fills the gap.
  // If the array is LONGER, truncate to expected length.
  const out = new Array(expectedLength).fill(null);
  const limit = Math.min(arr.length, expectedLength);
  for (let i = 0; i < limit; i += 1) {
    const entry = arr[i];
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim().toLowerCase();
    if (CLUSTER_TAXONOMY_SET.has(trimmed)) out[i] = trimmed;
  }
  return out;
}

/**
 * Strip Markdown code fences, leading prose, and `<think>` blocks
 * from an LLM response so JSON.parse stands a chance.
 */
/**
 * Recover a partial array from a truncated JSON string. The cluster
 * classifier sometimes runs out of output tokens mid-string when the
 * batch is large; rather than dropping ALL classifications we recover
 * the prefix up to the last complete `"cluster"` entry. Returns null
 * when no recovery is possible.
 *
 * Strategy:
 *   - Find the last complete quoted string by walking backwards from
 *     the end and locating the last unescaped `"`.
 *   - Find the last fully-closed comma after a quoted string.
 *   - Cut at that point, append `]` to close the array, and try parsing.
 *
 * Handles both top-level array `["a", "b", "c` and object-wrapped
 * `{"clusters": ["a", "b", "c` shapes (returns the array directly).
 *
 * @param {string} text — stripped LLM output that failed JSON.parse.
 * @returns {Array|null} — recovered array, or null on failure.
 */
function recoverTruncatedArray(text) {
  if (typeof text !== 'string' || !text) return null;
  const openIdx = text.indexOf('[');
  if (openIdx < 0) return null;
  // Extract all COMPLETE quoted strings within the array region using a
  // regex that handles escaped quotes. Anything truncated mid-string at
  // the end is automatically excluded since the regex requires a closing
  // unescaped `"`. Walk-backwards approaches were brittle when the cut
  // point was the OPENING quote of an incomplete entry — regex-extract
  // sidesteps that entirely.
  const arrayRegion = text.slice(openIdx);
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  const matches = arrayRegion.match(re);
  if (!matches || matches.length === 0) return null;
  try {
    return JSON.parse(`[${matches.join(',')}]`);
  } catch {
    return null;
  }
}

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
// Batch size for cluster classification. Empirical 2026-05-07: free-tier
// LLM providers (cluster in `ai-models.mjs`) cap output near 1024 chars
// (~250 tokens) regardless of `maxTokens` setting. With 350-headline
// batches the array got truncated at ~80 entries → 270 entries fell back
// to regex → all 'generic' cluster → diversity bonus 0 → ranker biased.
// Batches of 50 produce ~700 chars output (well under cap), 7 sequential
// calls for a typical 350-headline pool. Sequential to avoid rate limits;
// each call has its own retry + regex fallback so partial failures don't
// kill the whole classification.
const CLASSIFIER_BATCH_SIZE = 50;

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

  // Batch path: split into chunks of CLASSIFIER_BATCH_SIZE, classify each
  // separately, concat results. Avoids the output-truncation cliff that
  // killed full-pool classification on free-tier providers.
  if (list.length > CLASSIFIER_BATCH_SIZE) {
    const out = [];
    let totalOk = 0;
    let totalFallback = 0;
    for (let i = 0; i < list.length; i += CLASSIFIER_BATCH_SIZE) {
      const chunk = list.slice(i, i + CLASSIFIER_BATCH_SIZE);
      const chunkResult = await classifyChunk(chunk, callLLM, opts);
      out.push(...chunkResult.clusters);
      totalOk += chunkResult.okCount;
      totalFallback += chunkResult.fallbackCount;
    }
    const distMap = {};
    for (const c of out) distMap[c] = (distMap[c] || 0) + 1;
    const distStr = Object.entries(distMap).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join(' ');
    console.warn(`[classifier] batched ${Math.ceil(list.length / CLASSIFIER_BATCH_SIZE)} calls: LLM ok ${totalOk}/${list.length}, regex fallback ${totalFallback}/${list.length} → ${distStr}`);
    return out;
  }

  // Single-call path (small batches, including unit tests).
  const single = await classifyChunk(list, callLLM, opts);
  return single.clusters;
}

/**
 * Classify a single chunk via LLM with regex fallback. Returns an array
 * of clusters (length = chunk.length) plus diagnostic counts.
 *
 * @returns {Promise<{clusters: string[], okCount: number, fallbackCount: number}>}
 */
async function classifyChunk(list, callLLM, opts = {}) {
  const prompt = buildClusterClassifierPrompt(list);
  const messages = [
    { role: 'system', content: 'Sei un classificatore preciso. Rispondi SOLO con un array JSON, niente altro.' },
    { role: 'user', content: prompt },
  ];

  let raw;
  try {
    raw = await callLLM(messages, {
      temperature: 0,
      // Each cluster name (max 8 chars) + JSON quotes/comma ≈ 14 chars per
      // entry ≈ 4 tokens. With safety margin and overhead for the wrapping
      // object: 32 base + list.length * 8. Cap at 16384 (most providers
      // accept up to 16k output). Old cap of 1024 truncated arrays at
      // ~250 entries — diagnosed live 2026-05-07: log showed
      //   "Unterminated string at position 1043"
      // because batches of 350+ headlines blew through the 1024-token cap.
      maxTokens: Math.min(16384, 256 + list.length * 8),
      jsonMode: true,
      ...(opts.model ? { model: opts.model } : {}),
    });
  } catch (e) {
    console.warn(`[generator] cluster classifier LLM failed, regex fallback: ${e?.message || e}`);
    const fallback = list.map((h) => classifyByRegex(String(h ?? '')));
    return { clusters: fallback, okCount: 0, fallbackCount: list.length };
  }

  let parsed;
  const rawText = typeof raw === 'string' ? raw : raw?.content || '';
  const stripped = stripFenceAndPrefix(rawText);
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    // 2026-05-07 graceful recovery: when JSON.parse fails (most often due
    // to a truncated array — the model ran out of tokens mid-string), try
    // to recover the array prefix up to the last complete entry. Falls
    // back to all-regex only when no prefix can be recovered.
    parsed = recoverTruncatedArray(stripped);
    if (!parsed) {
      const preview = stripped.slice(0, 200).replace(/\s+/g, ' ');
      console.warn(`[classifier] LLM returned malformed JSON (parse error: ${e?.message || e}), regex fallback. raw[0..200]: "${preview}"`);
      const fallback = list.map((h) => classifyByRegex(String(h ?? '')));
      return { clusters: fallback, okCount: 0, fallbackCount: list.length };
    }
  }

  const coerced = coerceClusterArray(parsed, list.length);
  const nullCount = coerced.reduce((acc, v) => acc + (v == null ? 1 : 0), 0);
  const final = coerced.map((cluster, i) => cluster ?? classifyByRegex(String(list[i] ?? '')));
  return { clusters: final, okCount: list.length - nullCount, fallbackCount: nullCount };
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
// Diversity bonus floor at 0.1 — observed 2026-05-07 that the LLM
// classifier + regex fallback collapse most regional-news headlines
// into 'generic' cluster. With picks=11 in 'generic' on a typical day,
// 0.5^11 ≈ 0.0005 ≈ 0, killing the bonus entirely for 'generic'. Floor
// at 0.1 keeps a mild diversity tilt against over-represented clusters
// without excluding them outright. Fresh clusters (picks=0) still get
// the full 1.0; first repeat (picks=1) gets 0.5; etc.
//
// Curve:
//   0 picks → 1.0
//   1 pick  → 0.5
//   2 picks → 0.25
//   3 picks → 0.125
//   4+ picks→ 0.1 (floor)
function computeClusterDiversityBonus(cluster, todayPicksByCluster) {
  if (!cluster) return 0;
  const picks = (todayPicksByCluster && todayPicksByCluster[cluster]) || 0;
  if (picks <= 0) return 1.0;
  return Math.max(0.1, Math.pow(0.5, picks));
}

/**
 * Novelty bonus: 1.0 when the headline's max Jaccard with any
 * existing IT title is < NOVELTY_DUP_JACCARD; otherwise 0.
 *
 * @param {string} headline
 * @param {string[]} existingTitles
 * @returns {number}
 */
/**
 * Source-quality multiplier for a domain. Reads sourceQuality from the
 * article-performance.json output and returns a multiplier in
 * [SOURCE_QUALITY_MIN_MULTIPLIER, SOURCE_QUALITY_MAX_MULTIPLIER].
 *
 * Domains with no historical data return 1.0 (neutral).
 * Domains at exactly the median return 1.0.
 * Above median scales linearly to MAX (1.5x); below scales to MIN (0.5x).
 *
 * @param {string} domain — bare hostname (e.g. 'tio.ch').
 * @param {object} sourceQuality — {medianWinnerRate, perDomain: {...}}
 * @returns {number}
 */
export function sourceQualityMultiplier(domain, sourceQuality) {
  if (!domain || !sourceQuality || !sourceQuality.perDomain) return 1.0;
  const entry = sourceQuality.perDomain[domain];
  if (!entry || typeof entry.winnerRate !== 'number') return 1.0;
  // Need a meaningful sample size — single-article domains are noise.
  if ((entry.total || 0) < 3) return 1.0;
  const median = Number(sourceQuality.medianWinnerRate) || 0;
  if (median <= 0) return 1.0;
  const ratio = entry.winnerRate / median;
  // Linear interpolation: ratio=0 → MIN, ratio=1 → 1.0, ratio=2 → MAX.
  let multiplier;
  if (ratio <= 1) {
    multiplier = SOURCE_QUALITY_MIN_MULTIPLIER + (1 - SOURCE_QUALITY_MIN_MULTIPLIER) * ratio;
  } else {
    multiplier = 1 + (SOURCE_QUALITY_MAX_MULTIPLIER - 1) * Math.min(1, ratio - 1);
  }
  return Math.max(SOURCE_QUALITY_MIN_MULTIPLIER, Math.min(SOURCE_QUALITY_MAX_MULTIPLIER, multiplier));
}

function _domainFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

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

/**
 * Load the evergreen counter from disk. Returns `{count: 0}` on any
 * read/parse failure.
 */
export function loadEvergreenCounter(opts = {}) {
  const path = (opts && opts.path) || EVERGREEN_COUNTER_PATH;
  const raw = loadJsonSafe(path);
  if (!raw || typeof raw !== 'object' || typeof raw.count !== 'number' || raw.count < 0) {
    return { count: 0 };
  }
  return { count: Math.floor(raw.count) };
}

/**
 * Persist the evergreen counter to disk.
 */
export function persistEvergreenCounter(state, opts = {}) {
  const path = (opts && opts.path) || EVERGREEN_COUNTER_PATH;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ count: Math.max(0, Math.floor(state?.count || 0)) }, null, 2) + '\n', 'utf-8');
    return true;
  } catch (e) {
    console.warn(`[generator] could not write evergreen counter to ${path}: ${e.message}`);
    return false;
  }
}

/**
 * Decide whether THIS article-generator run should force the evergreen
 * path. Round-robin matching `EVERGREEN_QUOTA_DEFAULT` (30% by default).
 * Same shape as shouldUseExperimentalTier so the bucket math is
 * predictable: with ratio=0.30, bucket=3, threshold=1 → 1-of-3 runs
 * forced evergreen.
 */
export function shouldForceEvergreen(count, ratio = EVERGREEN_QUOTA_DEFAULT) {
  if (!ratio || ratio <= 0) return false;
  if (ratio >= 1) return true;
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

  const sourceQuality = opts.sourceQuality || null;
  const scored = list.map((h, i) => {
    const headlineText = titles[i];
    const baseBreakdown = scoreHeadline(headlineText, vocab, {
      todayPicksByCluster: opts.todayPicksByCluster || {},
      headlineCluster: clusters[i] || 'generic',
      existingTitles: opts.existingTitles || [],
    });
    // Source-quality multiplier: domains with historical winner-rate
    // above the corpus median get up to 1.5x boost; below median 0.5x.
    // Neutral 1.0 when no domain data is available.
    const url = (h && (h.url || h.link)) || null;
    const domain = _domainFromUrl(url);
    const sqMultiplier = sourceQuality ? sourceQualityMultiplier(domain, sourceQuality) : 1.0;
    const breakdown = sqMultiplier === 1.0
      ? baseBreakdown
      : { ...baseBreakdown, score: baseBreakdown.score * sqMultiplier, sourceQualityMultiplier: sqMultiplier };
    return { headline: h, breakdown, index: i };
  });

  // Sort desc by score; preserve original order on tie.
  scored.sort((a, b) => (b.breakdown.score - a.breakdown.score) || (a.index - b.index));

  // Hard cluster-quota cap (output-level diversity guard). Skip
  // headlines whose cluster has hit RANKER_MAX_PER_CLUSTER picks today.
  // The diversity bonus alone is a SOFT signal — strong demand-signal
  // headlines can outscore the bonus and collapse output to a single
  // cluster. This cap forces a hard skip.
  const picksByCluster = opts.todayPicksByCluster || {};
  const picks = [];
  for (const { headline, breakdown } of scored) {
    if (breakdown.score < minScore) break;
    const cluster = breakdown.cluster || 'generic';
    if ((picksByCluster[cluster] || 0) >= RANKER_MAX_PER_CLUSTER) {
      continue; // cluster is full — try next headline (different cluster)
    }
    picks.push({
      ...headline,
      _selectedSource: 'stable',
      _score: breakdown,
      _cluster: cluster,
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
