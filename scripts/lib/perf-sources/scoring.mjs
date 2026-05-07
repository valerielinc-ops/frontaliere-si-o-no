// Composite scoring + winner-fingerprint extraction.
// Pure functions — no I/O, no fetch — fully unit-testable.

// 2026-05-07 architectural decision: article-performance.json is PURE
// source analysis. No domain allowlist (deny). No domain boost (premium).
// User-traffic data is ground truth — TF-IDF math + score-weighted
// contributions + small recency tilt + fCount cap. Domain knowledge is
// reserved for SPECULATIVE sources (Suggest/News-RSS/Reddit) where user
// signal hasn't validated relevance yet.

// Recency influence in winner-weight blend. The composite score (clicks +
// impressions + adsense + scroll + ctr) is the dominant signal — it IS
// the user-validated traffic value. Recency is a mild tilt to favor fresh
// content among same-score articles, capped at 10%.
//
//   weight = score * ((1 - RECENCY_INFLUENCE) + RECENCY_INFLUENCE * recency)
//
// Old article (recency=0.16): weight = score * 0.916
// Fresh article (recency=1.0): weight = score * 1.000
// Diff ≈ 8% in favor of fresh, regardless of score magnitude.
//
// Empirical impact 2026-05-07: switching from pure-recency to score-weighted
// surfaces high-AdSense old winners (e.g. 'mutuo casa frontalieri italia'
// — top adsense €0.017, top pageviews 87, but published 71 days ago) which
// were being crushed under pure-recency at weight=0.16.
const RECENCY_INFLUENCE = 0.1;

/** Compute mean and (population) stddev. Returns {mean, sd} with sd>=1e-9. */
export function meanStd(values) {
  if (!values.length) return { mean: 0, sd: 1e-9 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const sd = Math.sqrt(variance);
  return { mean, sd: sd < 1e-9 ? 1e-9 : sd };
}

/** Z-normalize a metric across all articles where it's present (non-null). */
export function zNormalize(rows, key) {
  const present = rows.filter((r) => r[key] !== null && r[key] !== undefined && Number.isFinite(r[key]));
  const { mean, sd } = meanStd(present.map((r) => r[key]));
  /** @type {Map<unknown, number|null>} */
  const out = new Map();
  for (const r of rows) {
    const v = r[key];
    if (v === null || v === undefined || !Number.isFinite(v)) {
      out.set(r, null);
    } else {
      out.set(r, (v - mean) / sd);
    }
  }
  return out;
}

/**
 * Composite score per article. Skip articles where ALL metric channels are
 * null. Score weights match the spec scoreFormula:
 *   0.4*z(clicks) + 0.2*z(impressions) + 0.2*z(adsense_revenue||proxy)
 *   + 0.1*z(scroll_depth_p50) + 0.1*z(ctr)
 */
export function composeScores(rows) {
  const zClicks = zNormalize(rows, 'clicks');
  const zImpressions = zNormalize(rows, 'impressions');
  const zRevenue = zNormalize(rows, 'adsenseRevenueOrProxy');
  const zScroll = zNormalize(rows, 'scrollP50');
  const zCtr = zNormalize(rows, 'ctr');

  const scored = [];
  for (const r of rows) {
    const parts = [
      { z: zClicks.get(r), w: 0.4 },
      { z: zImpressions.get(r), w: 0.2 },
      { z: zRevenue.get(r), w: 0.2 },
      { z: zScroll.get(r), w: 0.1 },
      { z: zCtr.get(r), w: 0.1 },
    ];
    const usable = parts.filter((p) => p.z !== null);
    if (!usable.length) continue;
    const totalWeight = usable.reduce((a, p) => a + p.w, 0);
    const score = usable.reduce((a, p) => a + p.z * p.w, 0) / totalWeight;
    scored.push({ ...r, score: Number(score.toFixed(3)) });
  }
  return scored;
}

// CORE Italian stopwords — universal NLP infrastructure (articles,
// prepositions, conjunctions, auxiliary verbs, basic pronouns). These
// have no semantic content and would dominate any TF-IDF without being
// filtered. NOT a domain-bias filter: any TF-IDF over IT text needs them.
//
// 2026-05-07: extended-stopword additions (adverbs, news-verbs, date
// markers) were REMOVED on user direction. They could be content in
// context (e.g., "completamente" in "guida completamente aggiornata"),
// and the user's principle is no-suppression / no-bias for traffic-
// validated data. Only universally-non-content tokens remain.
const STOPWORDS_IT = new Set([
  // Articles, prepositions, conjunctions, particles
  'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'a', 'da', 'in',
  'con', 'su', 'per', 'tra', 'fra', 'e', 'ed', 'o', 'ma', 'che', 'chi', 'cui',
  'non', 'al', 'allo', 'alla', 'ai', 'agli', 'alle', 'del', 'dello', 'della',
  'dei', 'degli', 'delle', 'nel', 'nello', 'nella', 'nei', 'negli', 'nelle',
  'sul', 'sullo', 'sulla', 'sui', 'sugli', 'sulle', 'dal', 'dallo', 'dalla',
  'dai', 'dagli', 'dalle',
  // Auxiliary verbs (essere/avere conjugated)
  'è', 'sono', 'sei', 'siamo', 'siete', 'ho', 'hai', 'ha', 'abbiamo',
  'avete', 'hanno',
  // Question words (also in QUESTION_WORDS for angle extraction)
  'come', 'quando', 'quanto', 'quale',
  // Demonstratives, pronouns
  'questo', 'questa', 'questi', 'queste', 'quello', 'quella', 'quelli',
  'quelle', 'se', 'più', 'meno', 'molto', 'poco', 'tutto', 'tutti', 'tutte',
  'altro', 'altri', 'altre', 'cosa', 'tu', 'io', 'lui', 'lei', 'noi', 'voi',
  'loro', 'mi', 'ti', 'si', 'ci', 'vi', 'me', 'te', 'ne',
]);

const QUESTION_WORDS = ['come', 'quando', 'quanto', 'quanti', 'quante', 'cosa', 'chi', 'dove', 'perché', 'quale', 'qual'];

const ANGLE_PATTERNS = [
  { rx: /\bcome\s+\w+/i, label: 'come funziona' },
  { rx: /\bquando\s+\w+/i, label: 'quando conviene' },
  { rx: /\bquanto\s+\w+/i, label: 'quanto si guadagna/paga' },
  { rx: /\bvs\.?\b/i, label: 'X vs Y (confronto)' },
  { rx: /\bconfronto\b/i, label: 'confronto pratico' },
  { rx: /\bguida\s+pratica\b/i, label: 'guida pratica' },
  { rx: /\bguida\s+completa\b/i, label: 'guida completa' },
  { rx: /\bcalcolo\b/i, label: 'calcolo passo-passo' },
  { rx: /\bchecklist\b/i, label: 'checklist' },
  { rx: /\b(esempio|esempi)\b/i, label: 'esempio concreto' },
  { rx: /\bquanto\s+(costa|guadagn|paghi|prend)/i, label: 'quanto costa/guadagna' },
];

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-zàèéìòù0-9\s-]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS_IT.has(w));
}

/**
 * Token-frequency map across a list of documents, with optional per-document
 * weights (the recency factor). When `weights` is omitted, every document
 * counts as 1.0.
 *
 * @param {string[]} textList
 * @param {number[]|null} weights
 * @returns {Map<string, number>}
 */
function countTokensWeighted(textList, weights) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (let i = 0; i < textList.length; i += 1) {
    const text = textList[i];
    const w = weights ? Number(weights[i] ?? 1) : 1;
    if (!Number.isFinite(w) || w <= 0) continue;
    for (const tok of tokenize(text)) {
      counts.set(tok, (counts.get(tok) || 0) + w);
    }
  }
  return counts;
}

// IDF cap: bound `fullCount` per token so corpus-size doesn't asymptotically
// crush common evergreen terms (`frontalieri`, `ticino`, `svizzera` appearing
// in 8000+ of 8960 articles). Without the cap, log(1 + N/fCount) for those
// terms is ~0.001, so they rank way below 60th place and the domain filter
// finds zero survivors. With cap=50 the IDF boost becomes
// `log(1 + N/50)` ≈ 0.1 for any term in 50+ articles, putting evergreen
// frontaliere terms back into the top-60.
//
// 50 is empirically tuned: on a 70-article corpus (winners+losers) the cap
// is rarely hit; on a 8960-article corpus most terms are above 50 and the
// cap kicks in. Keeps the formula stable across corpus sizes (small dev
// fixtures and production cron both produce sensible top-N).
const MAX_FCOUNT_IDF = 50;

/**
 * Recency-weighted TF-IDF over a winner corpus vs the full corpus.
 *
 * Per the smarter-article-generator follow-up note in
 * memory/project_smarter_generator_may7.md, the unweighted variant
 * surfaced bursty news-of-day terms ("angeli", "grandine", "pastori")
 * because a single dated winner can outweigh evergreen frontaliere
 * topics. We weight each winner by `1 / (1 + ageDays/14)` (half-life
 * ~2 weeks) so recent-but-faded winners don't dominate the keyword
 * vocabulary that gets injected into the LLM prompt.
 *
 * The IDF term caps fCount at MAX_FCOUNT_IDF (default 50) so common
 * evergreen frontaliere terms don't get over-penalized when the full
 * corpus is large (8960+ articles in production). Without the cap,
 * `log(1 + N/fCount)` for terms appearing in 8000+ articles approaches
 * 0, dropping evergreen domain terms below the top-N threshold.
 *
 * @param {string[]} winnerCorpus
 * @param {string[]} fullCorpus
 * @param {number} n
 * @param {{ winnerWeights?: number[]|null, maxFCount?: number }} [opts]
 * @returns {string[]}
 */
function tfidfTopN(winnerCorpus, fullCorpus, n, { winnerWeights = null, maxFCount = MAX_FCOUNT_IDF, boostFn = null, boostFactor = 1.0 } = {}) {
  const winnerCounts = countTokensWeighted(winnerCorpus, winnerWeights);
  const fullCounts = countTokensWeighted(fullCorpus, null);
  // Effective corpus size for the TF normalizer matches the sum of weights
  // when present (so the formula stays consistent at weight=1.0). Falls
  // back to document count when no weights provided.
  const effectiveWinnerN = winnerWeights
    ? winnerWeights.reduce((a, w) => a + (Number.isFinite(w) && w > 0 ? Number(w) : 0), 0)
    : winnerCorpus.length;
  /** @type {Array<{token:string, score:number}>} */
  const scored = [];
  for (const [tok, wCount] of winnerCounts) {
    // Cap fCount at maxFCount: any term in ≥ maxFCount articles is treated
    // the same. Prevents corpus-size from crushing common terms.
    const rawFCount = fullCounts.get(tok) || 1;
    const fCount = Math.min(rawFCount, maxFCount);
    let score = (wCount / Math.max(1, effectiveWinnerN)) * Math.log(1 + (Math.max(1, effectiveWinnerN) / fCount));
    // Optional soft boost: when a token passes `boostFn`, multiply its
    // score by `boostFactor`. Used to favor domain-relevant terms WITHOUT
    // dropping non-domain tokens — surprise winners can still surface if
    // the user-traffic signal is strong enough. No-op when boostFn is null.
    if (boostFn && boostFn(tok)) {
      score *= boostFactor;
    }
    scored.push({ token: tok, score });
  }
  // Deterministic sort: score desc, alphabetic tie-break so output is
  // stable across runs even with float precision noise.
  scored.sort((a, b) => (b.score - a.score) || a.token.localeCompare(b.token));
  return scored.slice(0, n).map((s) => s.token);
}

/**
 * Recency factor for a published-at ISO date string. Recent articles get
 * a factor close to 1.0; older articles asymptotically approach 0.
 * Half-life is ~14 days (2 weeks). Returns 1.0 when `publishedAt` is
 * missing or unparseable so we don't accidentally zero-weight legitimate
 * winners with no date.
 *
 * @param {string|null|undefined} publishedAt
 * @param {number} [nowMs] — for test injection.
 * @returns {number}
 */
export function recencyWeight(publishedAt, nowMs = Date.now()) {
  if (!publishedAt) return 1.0;
  const t = Date.parse(publishedAt);
  if (!Number.isFinite(t)) return 1.0;
  const ageDays = Math.max(0, (nowMs - t) / 86_400_000);
  return 1 / (1 + ageDays / 14);
}

/**
 * Build the "winner fingerprint" from the top-N scored articles.
 *  - topClusters: weighted by share among winners.
 *  - topAngles: angle pattern hits (regex over title + excerpt).
 *  - topKeywords: TF-IDF tokens in winner titles vs full corpus.
 *  - averageWordCount: avg of provided wordCounts where present.
 *  - topQuestionPatterns: question-words appearing in titles.
 */
export function buildWinnerFingerprint(winners, allArticles) {
  if (!winners.length) {
    return {
      topClusters: [],
      topAngles: [],
      topKeywords: [],
      averageWordCount: null,
      topQuestionPatterns: [],
    };
  }

  // Clusters — drop the "unknown" placeholder produced when articleSection
  // wasn't resolvable for a winner (~99% of articles before the heuristic
  // classifier was added). Keeping it would emit a single
  // [{cluster:"unknown", weight:1.0}] entry that is misleading on disk and
  // already filtered out by article-topic-selector before LLM injection;
  // we filter producer-side too so the JSON file is clean for inspection.
  //
  // Lowercase-normalize defensively here: if any upstream caller forgets
  // to route through `normalizeClusterName`, we still emit canonical-cased
  // taxonomy values to disk (fixes the case-mismatch bug where losers
  // contained both "Pratico" and "pratico" for the same cluster).
  const clusterCounts = new Map();
  for (const w of winners) {
    const raw = w.cluster || 'unknown';
    const c = String(raw).trim().toLowerCase();
    if (!c || c === 'unknown') continue;
    clusterCounts.set(c, (clusterCounts.get(c) || 0) + 1);
  }
  const total = winners.length;
  const topClusters = clusterCounts.size === 0
    ? []
    : [...clusterCounts.entries()]
      .map(([cluster, n]) => ({ cluster, weight: Number((n / total).toFixed(3)) }))
      .sort((a, b) => b.weight - a.weight || a.cluster.localeCompare(b.cluster))
      .slice(0, 5);

  // Angles
  const angleCounts = new Map();
  for (const w of winners) {
    const blob = `${w.title || ''} ${w.excerpt || ''}`;
    for (const { rx, label } of ANGLE_PATTERNS) {
      if (rx.test(blob)) angleCounts.set(label, (angleCounts.get(label) || 0) + 1);
    }
  }
  const topAngles = [...angleCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([label]) => label);

  // Keywords — recency-weighted TF-IDF over winner titles+excerpts vs full
  // corpus. NO domain allowlist filter (removed 2026-05-07): these tokens
  // come from articles that already brought REAL traffic + revenue, so
  // the keyword is validated by user behavior. Pre-filtering with a
  // hardcoded regex would silently drop surprise winners outside our
  // prior beliefs of what counts as "frontaliere vocabulary" (e.g.,
  // 'mutuo'/'casa' on the top-AdSense article).
  //
  // Recency weighting handles bursty news-of-day risk: each winner is
  // weighted by `1/(1+ageDays/14)` so a 2-week-old article counts half
  // and a 4-week-old article counts a third. Combined with the fCount
  // cap in tfidfTopN, the math alone keeps the output stable across
  // corpus sizes and bursty-vs-evergreen content.
  const winnerCorpus = winners.map((w) => `${w.title || ''} ${w.excerpt || ''}`);
  const fullCorpus = allArticles.map((a) => `${a.title || ''} ${a.excerpt || ''}`);
  // Score-weighted contributions, recency contributes only 10%. The
  // composite `score` field IS the user-validated traffic value (clicks
  // + impressions + adsense + scroll + ctr); it should drive how much
  // each winner contributes to the TF-IDF token pool. Recency is a
  // small tilt (10%) so two equally-valued articles favor the fresh
  // one — but a high-revenue old article isn't crushed for its age.
  // No domain boost, no domain deny — pure source data, weighted by
  // user-validated value.
  const winnerWeights = winners.map((w) => {
    const baseScore = Math.max(0.01, Number(w.score) || 0.01);
    const recency = recencyWeight(w.publishedAt);
    return baseScore * ((1 - RECENCY_INFLUENCE) + RECENCY_INFLUENCE * recency);
  });
  const topKeywords = tfidfTopN(winnerCorpus, fullCorpus, 15, {
    winnerWeights,
  });

  // Question patterns: words appearing as the first token of any winner
  // title.
  const qCounts = new Map();
  for (const w of winners) {
    const t = (w.title || '').toLowerCase().trim();
    for (const q of QUESTION_WORDS) {
      const re = new RegExp(`(^|[\\s:.,!?])${q}\\b`, 'i');
      if (re.test(t)) qCounts.set(q, (qCounts.get(q) || 0) + 1);
    }
  }
  const topQuestionPatterns = [...qCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([w]) => w);

  // Average word count — emit `null` (not 0) when no winner exposes a
  // wordCount, so consumers can distinguish "unknown" from "zero".
  const wcs = winners.map((w) => w.wordCount).filter((n) => Number.isFinite(n) && n > 0);
  const averageWordCount = wcs.length
    ? Math.round(wcs.reduce((a, b) => a + b, 0) / wcs.length)
    : null;

  return { topClusters, topAngles, topKeywords, averageWordCount, topQuestionPatterns };
}

/**
 * Sort scored rows for deterministic top-N selection. Higher score first;
 * tie-break on URL ascending so output is reproducible.
 */
export function sortScored(rows) {
  return [...rows].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.url.localeCompare(b.url);
  });
}
