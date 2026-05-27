/**
 * Italian text similarity utilities used by scripts/create-article.mjs.
 *
 * Shared across:
 *   - preFlightEvergreenCheck   (evergreen keyword vs existing titles)
 *   - preFlightHeadlineCheck    (news headline vs existing article IDs)
 *   - checkForDuplicates        (post-generation duplicate detection)
 *
 * Three cooperating layers:
 *   1. STOP_WORDS_IT             — common Italian particles dropped before similarity
 *   2. stemIt(word)              — longest-suffix-first Italian stemmer
 *   3. SYNONYM_GROUPS / normalize — domain-specific synonym canonicalization
 *      (so "salario" and "stipendio" collapse to the same canonical token)
 *
 * Tokenization (`getWords`) lower-cases, strips punctuation, splits on
 * whitespace, drops tokens of length ≤ 2 and stop-words, then normalizes.
 *
 * Similarity functions:
 *   - jaccard(a, b)              — symmetric overlap (intersect / union)
 *   - containment(needle, hay)   — asymmetric (fraction of needle present)
 */

export const STOP_WORDS_IT = new Set([
  'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'a', 'da',
  'in', 'con', 'su', 'per', 'tra', 'fra', 'e', 'o', 'ma', 'che', 'non',
  'del', 'al', 'dal', 'nel', 'sul', 'dello', 'alla', 'della', 'dei', 'degli',
  'delle', 'ai', 'dai', 'nei', 'sui', 'è', 'sono', 'come', 'più', 'anche',
  'già', 'ancora', 'questo', 'questa', 'questi', 'queste', 'quello', 'quella',
  'molto', 'poco', 'tutto', 'tutti', 'ogni', 'altro', 'altra', 'altri', 'altre',
  'suo', 'sua', 'suoi', 'sue', 'loro', 'chi', 'cosa', 'dove', 'quando',
  'mentre', 'dopo', 'prima', 'tra', 'fino', 'solo', 'nuovo', 'nuova', 'nuovi',
  'base', 'rispetto', 'ultimo', 'ultima', 'ultimi', 'ultime',
]);

const STEMMER_SUFFIXES = [
  'izzazione', 'izzazioni',
  'amento', 'amenti', 'imento', 'imenti',
  'zione', 'zioni', 'sione', 'sioni',
  'abile', 'ibili', 'mente',
  'iere', 'ieri', 'iera', 'ance', 'enza', 'enze',
  'ante', 'anti', 'ente', 'enti',
  'ario', 'aria', 'ari',
  'tore', 'tori', 'trice', 'trici',
  'ista', 'isti', 'iste',
  'oso', 'osa', 'osi', 'ose',
  'ale', 'ali', 'ile', 'ili',
  'ato', 'ata', 'ati', 'ate', 'ito', 'ita', 'iti', 'ite',
  'ano', 'ana', 'ani', 'ane',
  'ino', 'ina', 'ini', 'ine',
  'one', 'oni',
  'ore', 'ori',
  'ura', 'ure',
  'io', 'ia', 'ie',
  'à', 'tà',
  'ere', 'are', 'ire',
];

/** Longest-suffix-first Italian stemmer. */
export function stemIt(word) {
  if (word.length <= 3) return word;
  for (const s of STEMMER_SUFFIXES) {
    if (word.endsWith(s) && (word.length - s.length) >= 3) {
      return word.slice(0, -s.length);
    }
  }
  if (/[aeiou]$/.test(word) && word.length > 4) {
    return word.slice(0, -1);
  }
  return word;
}

export const SYNONYM_GROUPS = [
  ['maternità', 'maternita', 'paternità', 'paternita', 'congedo', 'parentale', 'genitoriale', 'nascita', 'neonato', 'gestante', 'puerperio'],
  ['imposta', 'tassa', 'tasse', 'fiscale', 'fiscali', 'fisco', 'tributario', 'tributaria', 'irpef', 'imposizione'],
  ['stipendio', 'salario', 'retribuzione', 'busta', 'paga', 'reddito', 'ral', 'compenso', 'emolumento'],
  ['frontaliere', 'frontalieri', 'frontaliera', 'transfrontaliero', 'transfrontaliera', 'pendolare', 'pendolari', 'cross-border'],
  ['assicurazione', 'assicurazioni', 'copertura', 'polizza', 'lamal', 'cassa', 'malati', 'premio', 'premi'],
  ['pensione', 'pensioni', 'pensionamento', 'previdenza', 'avs', 'lpp', 'pilastro', 'rendita', 'rendite'],
  ['permesso', 'permessi', 'autorizzazione', 'autorizzazioni', 'visto'],
  ['trasporto', 'trasporti', 'mobilità', 'mobilita', 'pendolarismo', 'treno', 'treni', 'bus', 'auto', 'traffico'],
  ['casa', 'abitazione', 'alloggio', 'affitto', 'immobiliare', 'immobile', 'appartamento'],
  ['banca', 'bancario', 'bancaria', 'conto', 'finanza', 'finanziario', 'finanziaria'],
  ['lavoro', 'lavorare', 'lavoratore', 'lavoratori', 'lavoratrice', 'occupazione', 'impiego', 'mestiere'],
  ['figlio', 'figli', 'figlia', 'figlie', 'bambino', 'bambini', 'bambina', 'bambine', 'minore', 'minori'],
  ['svizzera', 'svizzero', 'elvetico', 'elvetica', 'confederazione', 'ch'],
  ['italia', 'italiano', 'italiana', 'italiani', 'italiane', 'tricolore', 'belpaese'],
  ['cambio', 'valuta', 'tasso', 'conversione', 'forex', 'chf', 'eur', 'euro', 'franco', 'franchi'],
  ['costo', 'costi', 'spesa', 'spese', 'prezzo', 'prezzi', 'tariffa', 'tariffe'],
  ['guida', 'tutorial', 'manuale', 'istruzioni', 'procedura', 'procedure', 'howto'],
  ['scuola', 'scolastico', 'scolastica', 'istruzione', 'educazione', 'asilo', 'nido'],
  ['sanità', 'sanita', 'sanitario', 'sanitaria', 'salute', 'medico', 'medica', 'ospedale', 'clinica'],
  ['lavori', 'cantiere', 'cantieri', 'risanamento', 'manutenzione', 'interventi', 'costruzione', 'ristrutturazione', 'rifacimento', 'pavimentazione'],
  ['strada', 'stradale', 'stradali', 'autostrada', 'autostradale', 'viabilità', 'viabilita', 'carreggiata', 'corsia'],
];

const SYNONYM_MAP = (() => {
  const m = new Map();
  for (const group of SYNONYM_GROUPS) {
    const canonical = group[0];
    for (const w of group) m.set(w, canonical);
  }
  return m;
})();

/** Map a word to its canonical form: synonym → stemmed → as-is. */
export function normalizeItWord(word) {
  if (SYNONYM_MAP.has(word)) return SYNONYM_MAP.get(word);
  const stemmed = stemIt(word);
  return SYNONYM_MAP.has(stemmed) ? SYNONYM_MAP.get(stemmed) : stemmed;
}

/**
 * Tokenize Italian text into normalized tokens for similarity comparison.
 * Treats hyphens as word separators (so article-ID slugs tokenize correctly).
 */
export function tokenizeIt(text) {
  return text.toLowerCase()
    .replace(/[^a-zàáèéìíòóùú0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(w => w.length > 2 && !STOP_WORDS_IT.has(w))
    .map(normalizeItWord);
}

/** Jaccard similarity: |A ∩ B| / |A ∪ B|. Symmetric. */
export function jaccardSim(a, b) {
  const sa = new Set(a), sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  const inter = [...sa].filter(w => sb.has(w)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

/** Containment: fraction of distinct `needle` tokens present in `haystack`. Asymmetric. */
export function containmentSim(needle, haystack) {
  const needleSet = new Set(needle);
  if (needleSet.size === 0) return 0;
  const haystackSet = new Set(haystack);
  return [...needleSet].filter(w => haystackSet.has(w)).length / needleSet.size;
}
