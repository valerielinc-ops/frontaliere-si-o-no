// scripts/lib/discovery/domainAnchor.mjs
//
// Single source of truth for "does this candidate look like it's about
// Ticino frontalieri?". Used to gate the discovery suggest source so
// generic Italian autocomplete (e.g. "mobilita palermo", "salute roma")
// can never be mistaken for a Ticino mobility/health topic.
//
// Why this exists:
//   2026-05-11 incident — `mobilita-palermo-frontalieri-ticino` was
//   published. Root cause: `pickClusterSeeds` in googleSuggestSource.mjs
//   passed bare cluster names (`mobilita`) as Google Suggest seeds.
//   Suggest returned "mobilita palermo" (a real Italian search trend
//   tied to the Palermo mobility crisis). The cluster classifier then
//   confirmed cluster=mobilita on the literal token, the discovery
//   score multiplied cluster_p50 * 0.6 to a high number, and the
//   embedding cascade matched it to "palma-muralto-..." (string-prefix
//   noise, not topic similarity). Article published.
//
// The fix is structural: every discovery candidate that comes from a
// generic-keyword source MUST mention at least one domain anchor token
// before it can enter the ranker. Anchors fall into four buckets:
//
//   1. core domain words      frontaliere/i, ticino/esi, svizzero/a, CH
//   2. cross-border concepts  permesso G, telelavoro, ristorni, AVS, LPP, LAMal
//   3. Ticino toponyms        Lugano, Chiasso, Mendrisio, Locarno, Bellinzona, …
//   4. CH-side & other CH cantons that recur in our content (Berna,
//      Zurigo, Basilea, Ginevra, Losanna, Vaud, Argovia, Vallese, …)
//
// We deliberately keep the list explicit and tight. False negatives
// (real Ticino topics rejected) are recoverable by adding the missing
// token. False positives (Palermo articles published) are not.

const ANCHOR_TOKENS = [
  // Core domain words
  'frontalier[ei]?',
  'ticin(o|esi?)',
  'svizzer[ao]',
  'svizzera',
  '\\bch\\b',
  '\\bchf\\b',
  'cross.?border',
  'grenzg(?:a|ae|ä)nger',

  // Cross-border concepts
  'permesso\\s*[gb]',
  'permesso\\s*frontaliere',
  'telelavoro',
  'smart\\s*working\\s*frontalier',
  'ristorni',
  '\\bavs\\b',
  '\\bahv\\b',
  '\\blpp\\b',
  '\\blamal\\b',
  'cassa\\s*malati',
  'busta\\s*paga\\s*svizzer',
  'dichiarazione\\s*frontalieri',
  'nuovo\\s*accordo\\s*fiscale',
  'pendolar(i|ismo)\\s*svizzer',

  // Ticino toponyms (curated — the ones that recur in our slug-registry)
  'lugano',
  'chiasso',
  'mendrisio',
  'locarno',
  'bellinzona',
  'biasca',
  'airolo',
  'stabio',
  'coldrerio',
  'balerna',
  'gordola',
  'massagno',
  'paradiso',
  'riva\\s*san\\s*vitale',
  'melide',
  'morbio',
  'rancate',
  'capolago',
  'caslano',
  'breganzona',
  'comano',
  'cadempino',
  'manno',
  'magliaso',
  'montagnola',
  'gentilino',
  'tesserete',
  'sementina',
  'giubiasco',
  'losone',
  'minusio',
  'orselina',
  'tenero',
  'cugnasco',
  'maggia',
  'cevio',
  'brissago',
  'ascona',
  'agno',
  'taverne',
  'arbedo',
  'mezzovico',
  'muralto',

  // Border IT towns where frontalieri live
  'como',
  'varese',
  'verbania',
  'sondrio',
  'lecco',
  'campione\\s*d',
  'maslianico',
  'cernobbio',
  'porlezza',
  'menaggio',
  'tirano',
  'luino',
  'gravedona',

  // Other CH cantons & cities that recur in cross-border content
  'berna',
  'berne',
  'zurigo',
  'zürich',
  'zurich',
  'basilea',
  'basel',
  'ginevra',
  'geneva',
  'gen[èe]ve',
  'losanna',
  'lausanne',
  'romandia',
  'romand',
  'vallese',
  'valais',
  'argovia',
  'aargau',
  'vaud',
  'sangallo',
  'st\\.?\\s*gallen',
  'grigioni',
  'graub[üu]nden',
  'briga',
  'brig',
];

const DOMAIN_ANCHOR_RE = new RegExp(`\\b(?:${ANCHOR_TOKENS.join('|')})\\b`, 'i');

/**
 * Test whether `text` mentions any token that anchors it to the
 * Ticino-frontalieri domain. Returns false for null/empty input.
 *
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
export function hasDomainAnchor(text) {
  if (!text || typeof text !== 'string') return false;
  return DOMAIN_ANCHOR_RE.test(text);
}

/**
 * Append the canonical anchor suffix to a bare seed term so Google
 * Suggest returns Ticino-relevant completions. Idempotent: a seed that
 * already contains an anchor is returned unchanged.
 *
 * @param {string} seed
 * @returns {string}
 */
export function anchorSeed(seed) {
  const s = typeof seed === 'string' ? seed.trim() : '';
  if (!s) return s;
  if (hasDomainAnchor(s)) return s;
  return `${s} frontalieri`;
}

export { DOMAIN_ANCHOR_RE };
