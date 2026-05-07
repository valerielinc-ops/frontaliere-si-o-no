// scripts/lib/cluster-classifier-prompt.mjs
//
// Phase A — Cluster classifier contract module.
//
// Contract between Phase A (regex-only fallback used now) and Phase B+C
// (LLM batch classifier + regex fallback used together). Defines the
// canonical cluster taxonomy, the regex patterns used as defense-in-depth
// fallback, and the LLM batch prompt template.
//
// The cluster taxonomy mirrors the winnerFingerprint clusters in
// `data/article-performance.json` plus two extensions accepted in the
// 2026-05-07 demand-driven plan: `salute` (LAMal demand) and `lavoro`
// (jobs/permits).

// Cluster names (in priority order for the regex classifier — first match
// wins). Extending this list requires a corresponding pattern entry in
// CLUSTER_PATTERNS and a definition in the LLM prompt.
export const CLUSTER_TAXONOMY = [
  'fiscale',
  'salute',
  'mobilita',
  'pratico',
  'lavoro',
  'novita',
  'generic',
];

// Regex/cluster pairs in priority order. For any input text, the first
// pattern that matches wins; if none match the result is `'generic'`.
//
// Patterns use leading `\b` (word boundary) and stem-prefix matching for
// inflected forms — e.g. `tass` matches "tasse"/"tassi"/"tassazione",
// `lavor` matches "lavoro"/"lavori"/"lavorare". DE/FR cognates included
// where frontaliere usage spans languages (`gehalt`, `salaire`,
// `quellensteuer`). The full anchor (`\b…\b`) is intentionally avoided
// for stems so inflected words still classify correctly; multi-word
// patterns and exact words use the fully-anchored form.
export const CLUSTER_PATTERNS = [
  {
    cluster: 'fiscale',
    pattern: /\b(tass|impost|irpef|fisc|quellensteuer|aliquot|deduzione|detrazione|busta\s*paga|salar|stipend|gehalt|salaire|ristorn|imposta\s*alla\s*fonte|\bchf\b|\beuro\b|cambio|valut)/i,
  },
  {
    cluster: 'salute',
    pattern: /\b(lamal|cmi|cassa\s*malati|krankenkass|assicur|premio|sanit|health|insurance|medico|hospital|ospedal)/i,
  },
  {
    cluster: 'mobilita',
    pattern: /\b(pendolar|valico|frontiera|dogana|treno|\bsbb\b|\btrain\b|\bbus\b|\bauto\b|\bcar\b|commute|chiasso|gaggiolo|fornasette|ponte\s*tresa|stabio)/i,
  },
  {
    cluster: 'pratico',
    pattern: /\b(permess(o|i)?\s*[gbl]|telelavoro|smart\s*working|t[eé]l[eé]travail|homeoffic|naspi|disoccupaz|rinnovo|cambio\s*indirizzo|datore\s*di\s*lavoro)/i,
  },
  {
    cluster: 'lavoro',
    pattern: /\b(lavor|jobs?|vacanc|posizione|assum|stage|tirocin|apprend|cerc[ao]\s*lavor|opportunit[aà])/i,
  },
  {
    cluster: 'novita',
    pattern: /\b(accordo|abkommen|nuovo|riforma|2025|2026|aggiornament|legge|decreto|cambia)/i,
  },
];

/**
 * Classify a single piece of text into one of CLUSTER_TAXONOMY using the
 * regex priority list. Returns `'generic'` if no pattern matches or input
 * is empty/non-string.
 *
 * @param {string} text — headline or keyword to classify.
 * @returns {string} — one of CLUSTER_TAXONOMY values.
 */
export function classifyByRegex(text) {
  if (!text || typeof text !== 'string') return 'generic';
  for (const { cluster, pattern } of CLUSTER_PATTERNS) {
    if (pattern.test(text)) return cluster;
  }
  return 'generic';
}

/**
 * Build a batch LLM prompt that classifies an array of headlines into
 * one of CLUSTER_TAXONOMY. The output contract is strict: the LLM must
 * return ONLY a JSON array of length N, each entry one of the taxonomy
 * strings exactly. No prose, no markdown.
 *
 * Phase A does NOT call this prompt — Phase B+C will, via the
 * `ai-models.mjs` failover cluster. Phase A only uses `classifyByRegex`
 * as the defense-in-depth fallback.
 *
 * @param {string[]} headlines — N headlines to classify.
 * @returns {string} — Italian-language batch classification prompt.
 */
export function buildClusterClassifierPrompt(headlines) {
  const list = Array.isArray(headlines) ? headlines : [];
  const n = list.length;
  const numbered = list
    .map((h, i) => `${i + 1}. ${String(h ?? '').replace(/\s+/g, ' ').trim()}`)
    .join('\n');
  return [
    'Classifica ogni headline in uno di questi cluster (rispondi con un array JSON di N stringhe):',
    '- fiscale: tasse, imposte, ristorni, salari, busta paga, valute',
    '- salute: cassa malati, LAMal, premi sanitari',
    '- mobilita: pendolarismo, valichi, treni, dogana',
    '- pratico: permessi (G/B), telelavoro, smart working, disoccupazione',
    '- lavoro: offerte, posizioni, tirocini, apprendistati',
    '- novita: nuove leggi, accordi, riforme, news 2026',
    '- generic: altro',
    '',
    'Headlines:',
    numbered,
    '',
    `Rispondi SOLO con un array JSON di esattamente ${n} elementi, ognuno una di queste 7 stringhe esatte: ["fiscale","salute","mobilita","pratico","lavoro","novita","generic"]. Niente prosa, niente markdown.`,
  ].join('\n');
}

export default classifyByRegex;
