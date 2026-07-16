// scripts/lib/query-tokenizer.mjs
//
// Shared IT/EN/DE/FR search-query tokenization, stemming, locale detection,
// and role/region canonicalization. Extracted from cluster-orphan-queries.mjs
// (GSC orphan-query clustering) so scripts/mine-internal-search-terms.mjs
// (PostHog internal-search mining, issue #4301) can reuse the identical
// logic instead of duplicating the STOPWORDS / STEM_RULES / REGION_TOKENS
// constants and the tokenize/canonicalize functions — see AGENTS.md
// non-negotiable #6 (duplicated regex/constant in ≥2 files → shared module).
//
// Pure functions, no fs/network access — safe to import from both a
// one-off data-pull script and (in principle) a build plugin.

// ─── Stopword sets (IT/EN/DE/FR) ──────────────────────────────────
export const STOPWORDS = new Set([
  // Italian
  'a','al','alla','allo','alle','ai','agli','di','da','del','dello','della','dei','degli','delle',
  'in','un','uno','una','con','per','il','lo','la','gli','le','e','ed','o','od','che','chi','ciò',
  'ciao','come','cosa','cui','ne','non','più','meno','essere','io','mi','tu','ti','si','ci','vi',
  'sono','loro','nostro','vostro','su','sul','sulla','sulle','sui','sugli','tra','fra','dopo',
  'prima','senza','questa','questo','questi','queste','quel','quella','quello',
  // English
  'the','of','in','for','to','and','or','a','an','with','at','by','from','on','off','up','down',
  'as','is','are','be','been','being','has','have','had','do','does','did','will','would','should',
  'can','could','may','might','must','shall','not','no',
  // German
  'der','die','das','den','dem','des','ein','eine','einen','einem','einer','eines','und','oder',
  'mit','bei','in','im','am','an','auf','zu','von','aus','für','durch','um','nach','vor','ohne',
  'gegen','zwischen','über','unter','hinter','neben','sein','ist','bin','bist','sind','seid',
  // French
  'le','la','les','l','un','une','des','du','de','d','et','ou','où','pour','par','avec','sans',
  'dans','en','sur','sous','vers','chez','aux','au','à','ce','ces','cette','ses','son','sa',
  // Generic job words — kept OUT of stopwords because they're part of role signal
]);

// Minimal multi-language stemming: remove common plural/gender endings.
export const STEM_RULES = [
  /innen?$/,   // DE fem. plural → root  (Mitarbeiterinnen → Mitarbeiter)
  /euse$/,     // FR fem. suffix → eur   (chauffeuse → chauff)
  /teur$/, /teuse$/,
  /eurs?$/,    // FR → eur
  /ieres?$/,   // IT/FR fem.
  /iere$/,
  /ori$/, /ore$/, /ori$/, /ice$/, /ici$/, // IT
  /i$/, /e$/, /o$/, /a$/, // IT/generic final-vowel trim as very-last step
  /ing$/,      // EN gerund
  /s$/,        // EN plural
];

export function stemToken(tok) {
  if (!tok) return tok;
  if (tok.length <= 3) return tok;
  // Apply the first rule that strips at least one char and leaves ≥3 chars remaining.
  for (const rule of STEM_RULES) {
    const next = tok.replace(rule, '');
    if (next.length >= 3 && next.length < tok.length) return next;
  }
  return tok;
}

// ─── Locale detection heuristics ──────────────────────────────────
export const LOCALE_HINTS = {
  it: ['lavoro','lavori','offerta','offerte','assunzione','assume','assunzioni','aziende','stipendio','posti','posto','cerca','cerco','ticino','svizzera','italiani','lugano','mendrisio','chiasso','bellinzona','locarno','frontaliere','concorso','concorsi'],
  de: ['jobs','job','stellen','stelle','arbeit','arbeits','schweiz','tessin','stellenangebote','stellenangebot','mitarbeiter','mitarbeiterin','suche','offene','stellensuche','als','bei','für'],
  en: ['jobs','job','work','switzerland','swiss','ticino','employment','careers','career','vacancies','vacancy','hiring','engineer','developer','nurse','nurses'],
  fr: ['emploi','emplois','travail','suisse','tessin','offres','offre','recherche','poste','postes','carriere','postuler','chauffeur'],
};

export function detectLocale(tokens) {
  const scores = { it: 0, de: 0, en: 0, fr: 0 };
  for (const t of tokens) {
    for (const [loc, hints] of Object.entries(LOCALE_HINTS)) {
      if (hints.includes(t)) scores[loc] += 1;
    }
  }
  let best = 'it';
  let bestScore = -1;
  for (const loc of ['it','de','en','fr']) {
    if (scores[loc] > bestScore) { best = loc; bestScore = scores[loc]; }
  }
  // If all zero, default to IT (primary locale of the site).
  return best;
}

// ─── Tokenization ─────────────────────────────────────────────────
export function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(q) {
  const norm = normalize(q);
  if (!norm) return [];
  return norm
    .split(/[\s-]+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

// ─── Region / role token separation ────────────────────────────────
// "Region" is any geographic term we recognize; everything else is a role token.
export const REGION_TOKENS = new Set([
  // Ticino towns + cantons
  'ticino','tessin','lugano','mendrisio','chiasso','bellinzona','locarno','biasca',
  'stabio','balerna','giubiasco','massagno','manno','paradiso','melide',
  // Swiss cantons + top cities
  'svizzera','schweiz','swiss','suisse','switzerland',
  'zurigo','zurich','zürich','basilea','basel','ginevra','geneve','geneva',
  'berna','bern','lucerna','luzern','lucerne','losanna','lausanne','friburgo',
  'friborgo','fribourg','sangallo','gallen','vallese','valais','valle','grigioni',
  'graubunden','graubünden','neuchatel','neuenburg','wallis','jura','vaud',
  'solothurn','soletta','uri','zug','aargau','argovia',
  // Italian near-border (cross-border relevance)
  'como','varese','milano','lecco','sondrio',
  // Generic
  'ci','ch','italia','italy','italien',
]);

export function splitRoleRegion(tokens) {
  const role = [];
  const region = [];
  for (const t of tokens) {
    if (REGION_TOKENS.has(t)) region.push(t);
    else role.push(t);
  }
  return { role, region };
}

export function canonicalizeRegion(tokens) {
  // Collapse synonyms so clusters merge across locales.
  const canon = tokens.map(t => {
    if (['ticino','tessin'].includes(t)) return 'ticino';
    if (['svizzera','schweiz','swiss','suisse','switzerland'].includes(t)) return 'svizzera';
    if (['zurigo','zurich','zürich'].includes(t)) return 'zurigo';
    if (['basilea','basel'].includes(t)) return 'basilea';
    if (['ginevra','geneve','geneva'].includes(t)) return 'ginevra';
    if (['berna','bern'].includes(t)) return 'berna';
    if (['lucerna','luzern','lucerne'].includes(t)) return 'lucerna';
    if (['losanna','lausanne'].includes(t)) return 'losanna';
    if (['grigioni','graubunden','graubünden'].includes(t)) return 'grigioni';
    if (['vallese','valais','wallis'].includes(t)) return 'vallese';
    if (['friburgo','friborgo','fribourg'].includes(t)) return 'friburgo';
    return t;
  });
  // Dedup and sort for stable signature
  return [...new Set(canon)].sort();
}

export function canonicalizeRole(tokens) {
  const stems = tokens.map(stemToken).filter(Boolean);
  return [...new Set(stems)].sort();
}

// ─── Slugify for cluster canonical slug ────────────────────────────
export function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
