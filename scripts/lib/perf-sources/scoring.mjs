// Composite scoring + winner-fingerprint extraction.
// Pure functions — no I/O, no fetch — fully unit-testable.

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

const STOPWORDS_IT = new Set([
  'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'a', 'da', 'in',
  'con', 'su', 'per', 'tra', 'fra', 'e', 'ed', 'o', 'ma', 'che', 'chi', 'cui',
  'non', 'al', 'allo', 'alla', 'ai', 'agli', 'alle', 'del', 'dello', 'della',
  'dei', 'degli', 'delle', 'nel', 'nello', 'nella', 'nei', 'negli', 'nelle',
  'sul', 'sullo', 'sulla', 'sui', 'sugli', 'sulle', 'dal', 'dallo', 'dalla',
  'dai', 'dagli', 'dalle', 'è', 'sono', 'sei', 'siamo', 'siete', 'ho', 'hai',
  'ha', 'abbiamo', 'avete', 'hanno', 'come', 'quando', 'quanto', 'quale',
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

function countTokens(textList) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const text of textList) {
    for (const tok of tokenize(text)) {
      counts.set(tok, (counts.get(tok) || 0) + 1);
    }
  }
  return counts;
}

function tfidfTopN(winnerCorpus, fullCorpus, n) {
  const winnerCounts = countTokens(winnerCorpus);
  const fullCounts = countTokens(fullCorpus);
  /** @type {Array<{token:string, score:number}>} */
  const scored = [];
  for (const [tok, wCount] of winnerCounts) {
    const fCount = fullCounts.get(tok) || 1;
    // Boost terms common in winners but not absurdly common across the whole
    // corpus.
    const score = (wCount / Math.max(1, winnerCorpus.length)) * Math.log(1 + (winnerCorpus.length / fCount));
    scored.push({ token: tok, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n).map((s) => s.token);
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
      averageWordCount: 0,
      topQuestionPatterns: [],
    };
  }

  // Clusters
  const clusterCounts = new Map();
  for (const w of winners) {
    const c = w.cluster || 'unknown';
    clusterCounts.set(c, (clusterCounts.get(c) || 0) + 1);
  }
  const total = winners.length;
  const topClusters = [...clusterCounts.entries()]
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

  // Keywords
  const winnerCorpus = winners.map((w) => `${w.title} ${w.excerpt}`);
  const fullCorpus = allArticles.map((a) => `${a.title} ${a.excerpt}`);
  const topKeywords = tfidfTopN(winnerCorpus, fullCorpus, 15);

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

  // Average word count
  const wcs = winners.map((w) => w.wordCount).filter((n) => Number.isFinite(n) && n > 0);
  const averageWordCount = wcs.length ? Math.round(wcs.reduce((a, b) => a + b, 0) / wcs.length) : 0;

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
