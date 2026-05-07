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

// ── Paths (overridable via opts for tests) ─────────────────────
export const PERFORMANCE_PATH = 'data/article-performance.json';
export const CANDIDATES_PATH = 'data/topic-candidates.json';
export const CONSUMED_PATH = 'data/topic-candidates-consumed.json';

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
function tokenize(s) {
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

// Keywords we accept as "frontalieri-domain" priors. Anything not matching
// is dropped to keep the LLM prompt useful instead of polluted with bursty
// news-of-day terms that happen to TF-IDF high.
const FRONTALIERI_DOMAIN_RE = /\b(frontal|grenzg|permess(o|i)\s*[gbl]|tass[ae]|fisco|fiscal|imposta|irpef|quellensteuer|busta\s*paga|salar|stipend|salaire|gehalt|cassa\s*malati|lamal|cmi|assicur|krankenkass|pension|avs|ahv|lpp|bvg|terzo\s*pilastro|secondo\s*pilastro|3a|3b|cambio|chf|euro|valut|telelavoro|smart\s*working|t[ée]l[ée]travail|homeoffic|pendolar|commut|dogana|valico|frontiera|bordo|bord[ée]r|naspi|disoccupaz|ristorn|accordo|abkommen|bilateral|svizzer|switzer|tessin|ticin|lombard|comask|varesin|grigion|grauen)/i;

export function isFrontalieriDomainTerm(term) {
  if (!term || typeof term !== 'string') return false;
  return FRONTALIERI_DOMAIN_RE.test(term);
}

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

export default {
  PERFORMANCE_PATH,
  CANDIDATES_PATH,
  CONSUMED_PATH,
  CONSUMED_MAX_IDS,
  CANDIDATE_MIN_SCORE,
  CANDIDATE_DUP_JACCARD,
  loadJsonSafe,
  jaccardSimilarity,
  extractItTitlesFromMeta,
  loadExistingItTitles,
  isCandidateDuplicate,
  loadConsumedTracker,
  appendConsumedId,
  persistConsumedTracker,
  pickTopCandidate,
  buildWinnerFingerprintMessage,
};
