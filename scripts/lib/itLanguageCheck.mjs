/**
 * Non-Italian script detector for model-output sanity checks.
 *
 * History — run 26446721285 (2026-05-26): the fallback chain rotated to
 * nvidia/llama-3.3-nemotron-super-49b-v1 which produced a 100%-Chinese
 * headline ("AVS超過2.6百万人领取老年金"). The validator rejected it as
 * "1 parola, range 2-22" but only AFTER consuming the entire headline-
 * retry budget — the run hard-failed with no article published.
 *
 * This helper catches the drift at the JSON-validation layer so the chain
 * rotates to a different model (via `recordModelContentFailure`) without
 * burning the outer headline-validation budget. The threshold is
 * deliberately permissive (10%): Italian editorial titles may legitimately
 * contain single CJK names (e.g. "北京") in quoted brand references, but
 * >10% means the body of the text is non-IT.
 */

// Non-Latin "letter" ranges that we treat as evidence the model has
// switched language. Covers Cyrillic, Armenian, Hebrew, Arabic, CJK
// punctuation/Hiragana/Katakana, CJK Ext-A, CJK Unified, and Hangul.
const NON_LATIN_SCRIPT_RE = /[Ѐ-ԯ԰-֏֐-׿؀-ۿ　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿가-힯]/gu;
// All Unicode letters — denominator for the ratio.
const ANY_LETTER_RE = /\p{L}/gu;

/**
 * Returns the fraction of "letter" characters in `text` that belong to a
 * non-Latin script (CJK / Cyrillic / Hebrew / Arabic / Hangul / Armenian).
 * Range 0..1. Returns 0 for non-strings, empty strings, or strings with
 * no letters at all.
 *
 * @param {string} text
 * @returns {number}
 */
export function nonItalianScriptRatio(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const letters = text.match(ANY_LETTER_RE) || [];
  if (letters.length === 0) return 0;
  const nonLatin = text.match(NON_LATIN_SCRIPT_RE) || [];
  return nonLatin.length / letters.length;
}

/**
 * `true` if more than `threshold` (default 10%) of the letters in `text`
 * belong to a non-Latin script. Use to gate fallback model output.
 *
 * @param {string} text
 * @param {number} [threshold=0.1]
 * @returns {boolean}
 */
export function isNonItalianScript(text, threshold = 0.1) {
  return nonItalianScriptRatio(text) > threshold;
}

/**
 * ── IL SECONDO MODO DI SBAGLIARE LINGUA: quello in alfabeto latino ────────
 *
 * `isNonItalianScript` sopra vede solo il cambio di SCRITTURA. Un titolo
 * inglese, tedesco o francese ha ratio 0 — esce `verdict:"ok"`, diventa slug
 * e canonical, e va live senza rebuild del sito (issue #800). Il buco non era
 * teorico: sui 5.682 `title` IT pubblicati questo rilevatore ne trova UNO,
 * «SBB controllers getting bonuses for fines? What frontalieri need to know»,
 * cioe' esattamente il difetto, gia' in produzione.
 *
 * Il rilevatore deve essere DETERMINISTICO e senza dipendenze (questo modulo e
 * `body2-payload-verdict.mjs` sono tenuti puri apposta). `detect-language.mjs`
 * esiste, ma e' tarato su annunci di lavoro interi: misurato sugli stessi
 * 5.682 titoli sbaglia 1.287 volte (22,6%). Su una superficie che pubblica
 * senza rete di salvataggio un falso positivo costa un articolo buttato, e a
 * 22% costerebbe un quinto del corpus — per questo qui c'e' un criterio
 * diverso invece del riuso, e per questo la soglia e' scelta su una MISURA.
 *
 * Due segnali indipendenti, entrambi conservativi:
 *
 *  1. PAROLE FUNZIONE ESCLUSIVE. Le quattro liste sono deduplicate fra loro
 *     (`la`, `le`, `un`, `il`, `a`, `in`, `des`… stanno in piu' lingue e
 *     spariscono da tutte): resta solo cio' che discrimina. Serve un margine
 *     di 2 sulla lingua attesa, quindi una singola citazione straniera in un
 *     titolo italiano non basta.
 *
 *  2. MORFOLOGIA. In italiano quasi ogni parola finisce per vocale. Misurato
 *     sui corpora pubblicati: IT p1 = 0,45 (minimo 0,10), EN p90 = 0,50,
 *     DE p90 = 0,50, FR p50 = 0,38. La soglia 0,35 sta sotto il primo
 *     percentile italiano e coglie comunque il 41% dei titoli EN da sola.
 *     Vale solo con ZERO parole-funzione italiane nel testo: un titolo
 *     italiano fitto di nomi propri stranieri ne ha sempre almeno una.
 */

// Liste grezze: ridondanti apposta. Una parola ambigua va messa in TUTTE le
// lingue in cui esiste — `dedupeExclusive` la toglie da tutte, ed e' quello il
// modo di dichiararla non-discriminante senza doverci ragionare al call site.
const RAW_MARKER_WORDS = {
  it: `il lo la gli le i un uno una di del dello della dei degli delle dal dalla dai dagli
       nel nello nella nei negli nelle sul sullo sulla sui col con per tra fra che chi cui
       come quando dove perche piu meno anche ma pero se non sono essere cosa quale quali
       quanto quanti quante questo questa questi queste tutto tutti tutta tutte tuo tua
       tuoi suo sua loro nostro vostro gia ancora dopo prima senza sotto sopra verso ogni
       molto solo mai cosi ecco oltre invece quindi mentre dunque nulla nessuno
       a in no o e ed ha hanno da su si ne mi ho qui`,
  en: `the and of for with from your you are were how what why which this that these those
       their there its will would could should must about into over under between after
       before when where who whose not but all more most than then they them our has have
       had been being does did may might
       a in no so do or at by to on an we us it is my me i`,
  de: `und oder der die das den dem des ein eine einen einem eines ist sind waren wird
       werden wurde nicht fur mit von vom auf aus bei beim zum zur zu als auch aber wie wer
       wenn dass sich sie wir ihr ihre sein haben hat kann konnen mehr nach uber unter vor
       durch gegen ohne noch nur schon jetzt neue neuen
       in im an am so`,
  fr: `les des du aux et est sont etre avec pour dans sur sous par que quoi ne pas plus ce
       cette ces cet son ses leur leurs nous vous ils elles mais ou comment pourquoi tous
       toute toutes votre notre vos nos une elle peut doit tres aussi encore deja entre
       chez depuis apres avant
       le la un il qui se si a de en on y sa ma`,
};

/** Le lingue su cui il rilevatore sa esprimersi. Fuori da qui torna sempre `null`. */
export const LATIN_MARKER_LOCALES = Object.keys(RAW_MARKER_WORDS);

/** minuscole + diacritici rimossi: `perché` e `perche` sono la stessa parola. */
function foldText(text) {
  return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function dedupeExclusive(raw) {
  const sets = {};
  for (const [locale, words] of Object.entries(raw)) {
    sets[locale] = new Set(foldText(words).split(/\s+/).filter(Boolean));
  }
  const seen = new Map();
  for (const set of Object.values(sets)) {
    for (const word of set) seen.set(word, (seen.get(word) || 0) + 1);
  }
  for (const [word, n] of seen) {
    if (n > 1) for (const set of Object.values(sets)) set.delete(word);
  }
  return sets;
}

const MARKER_WORDS_BY_LOCALE = dedupeExclusive(RAW_MARKER_WORDS);

/**
 * Quante parole-funzione ESCLUSIVE di ciascuna lingua compaiono in `text`.
 *
 * @param {string} text
 * @returns {{ it: number, en: number, de: number, fr: number }}
 */
export function latinLanguageMarkerHits(text) {
  const hits = { it: 0, en: 0, de: 0, fr: 0 };
  if (typeof text !== 'string' || text.length === 0) return hits;
  for (const token of foldText(text).match(/[a-z']+/g) || []) {
    for (const [locale, set] of Object.entries(MARKER_WORDS_BY_LOCALE)) {
      if (set.has(token)) hits[locale] += 1;
    }
  }
  return hits;
}

/**
 * Frazione di parole (>= 3 lettere) che finiscono per vocale — il segnale
 * morfologico dell'italiano. `null` quando le parole sono troppo poche perche'
 * la frazione voglia dire qualcosa.
 *
 * @param {string} text
 * @param {number} [minWords=4]
 * @returns {number|null}
 */
export function vowelFinalWordRatio(text, minWords = 4) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const words = (foldText(text).match(/[a-z]+/g) || []).filter((w) => w.length >= 3);
  if (words.length < minWords) return null;
  return words.filter((w) => /[aeiou]$/.test(w)).length / words.length;
}

/** Colpi minimi perche' le parole-funzione da sole bastino a decidere. */
export const MARKER_MIN_HITS = 3;
/** ...e di quanto devono superare la lingua attesa. */
export const MARKER_MIN_MARGIN = 2;

/** Sotto questa frazione un testo non e' italiano. Misurata: IT p1 = 0,45. */
export const IT_VOWEL_FINAL_FLOOR = 0.35;
/**
 * Sopra questa frazione un testo E' italiano, e quindi sbagliato altrove.
 * Misurata: EN/DE p90 = 0,50, IT p50 = 0,88.
 */
export const IT_VOWEL_FINAL_CEILING = 0.75;

/**
 * `true`-ish se `text` e' scritto, con evidenza, in una lingua latina DIVERSA
 * da `locale`. Torna `null` — non `false` — quando non c'e' evidenza: assenza
 * di prova, non prova di assenza, ed e' la ragione per cui il chiamante puo'
 * usarlo come guardia senza rigettare tutto cio' che non riconosce.
 *
 * @param {string} text
 * @param {string} locale  la lingua attesa (`it`|`en`|`de`|`fr`).
 * @returns {{ lang: string, reason: 'markers'|'morphology' }|null}
 */
export function detectWrongLatinLanguage(text, locale = 'it') {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  if (!LATIN_MARKER_LOCALES.includes(locale)) return null;

  const hits = latinLanguageMarkerHits(text);
  const own = hits[locale];
  let best = null;
  for (const other of LATIN_MARKER_LOCALES) {
    if (other === locale) continue;
    if (best === null || hits[other] > hits[best]) best = other;
  }
  // Tre colpi, e almeno due piu' della lingua attesa. Con due bastava
  // «Over 65 superano under 20: la svolta demografica svizzera» — italiano,
  // due avverbi inglesi — per farsi rigettare: misurato, era l'unico falso
  // positivo del rilevatore sui 5.682 titoli pubblicati, e sparisce a tre.
  if (best !== null && hits[best] >= MARKER_MIN_HITS && hits[best] >= own + MARKER_MIN_MARGIN) {
    return { lang: best, reason: 'markers' };
  }

  // La morfologia misura UNA cosa sola: quanto il testo somiglia all'italiano.
  // Non e' un classificatore a quattro vie, quindi si applica solo dove la
  // domanda e' «e' italiano?» — la lingua attesa e' `it`, oppure il testo e'
  // cosi' italiano da esserlo per forza. Il francese e' il vicino scomodo
  // (p50 = 0,38 contro 0,88 dell'italiano, ma le code si toccano): per questo
  // dall'altro lato serve ANCHE il concorso delle parole-funzione italiane.
  const ratio = vowelFinalWordRatio(text);
  if (ratio === null) return null;
  if (locale === 'it') {
    if (ratio <= IT_VOWEL_FINAL_FLOOR && own === 0) return { lang: 'non-it', reason: 'morphology' };
    return null;
  }
  if (ratio >= IT_VOWEL_FINAL_CEILING && own === 0 && hits.it >= MARKER_MIN_MARGIN) {
    return { lang: 'it', reason: 'morphology' };
  }
  return null;
}

/**
 * Campi meta dove una tabella compatta di aliquote e' contenuto LEGITTIMO, e
 * dove quindi la deroga misurata in #1177 si applica.
 *
 * `excerpt` e' la sorgente; `description`, `ogDescription` e
 * `twitterDescription` ne sono la copia — `create-article.mjs` li deriva da
 * `it.excerpt`, e le stesse stringhe finiscono in `content/seo/`. Derogare
 * sull'excerpt e non su di loro
 * significherebbe accettare l'articolo in generazione e poi vederlo rifiutato
 * dallo scan SEO del corpus pubblicato: rosso su OGNI PR successiva, per un
 * contenuto che il gate ha gia' dichiarato valido.
 *
 * `title` e `ogTitle` restano FUORI: la soglia morfologica e' stata misurata
 * sui titoli, dove non ha falsi positivi, e li' una tabella di aliquote non e'
 * contenuto atteso.
 */
export const RATE_TABLE_DEROGATION_FIELDS = [
  'excerpt',
  'description',
  'ogDescription',
  'twitterDescription',
];

// Sigle che possono aprire una riga della tabella delle trattenute svizzere.
// Il prefisso della riga e' intenzionalmente chiuso: un acronimo qualunque
// (es. `GDP`) non puo' trasformare una frase inglese in una tabella italiana.
const SWISS_RATE_CODE = '(?:AVS|AI|IPG|AD|AC|LAINF|LAA|LPP)';
const SWISS_RATE_CODE_GROUP = `${SWISS_RATE_CODE}`
  + `(?:\\s*/\\s*${SWISS_RATE_CODE}|\\s*\\(\\s*${SWISS_RATE_CODE}\\s*\\))*`;
const SWISS_RATE_VALUE = `\\d+(?:[.,]\\d+)?`
  + `(?:\\s*[-–]\\s*\\d+(?:[.,]\\d+)?)?\\s*%`;
const SWISS_RATE_ROW = `${SWISS_RATE_CODE_GROUP}\\s*(?:[:=]\\s*)?${SWISS_RATE_VALUE}`;
const SWISS_RATE_HEADING = '(?:aliquot(?:e|a)|contribut(?:i|o)|percentual(?:e|i))';
const SWISS_RATE_ROW_RE = new RegExp(
  `(?:^\\s*(?:${SWISS_RATE_HEADING}\\s*:\\s*)?|[,;|\\r\\n]\\s*)`
    + `(?:[-*•]\\s*)?${SWISS_RATE_ROW}`,
  'gi',
);
const SWISS_RATE_TABLE_RE = new RegExp(
  `^\\s*(?:${SWISS_RATE_HEADING}\\s*:\\s*)?`
    + `(?:[-*•]\\s*)?${SWISS_RATE_ROW}`
    + `(?:\\s*(?:[,;|]|\\r\\n|\\n)\\s*(?:[-*•]\\s*)?${SWISS_RATE_ROW})+`
    + `\\s*\\.?\\s*$`,
  'i',
);

/**
 * `true` se il testo e' una tabella compatta di aliquote e sigle italiana:
 * almeno due percentuali, almeno due acronimi e almeno due righe complete di
 * aliquota svizzera. La morfologia, tarata sulla prosa, legge questa forma
 * come non-italiana anche quando e' italiana; la grammatica chiusa ammette
 * label e bullet di tabella, ma nessuna prosa residua.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isCompactItalianRateTable(value) {
  if (typeof value !== 'string') return false;
  const percentages = value.match(/\b\d+(?:[.,]\d+)?\s*%/g) ?? [];
  const acronyms = value.match(/\b[A-Z]{2,}(?:\/[A-Z]{2,})*\b/g) ?? [];
  const hasSwissRateCluster = (value.match(SWISS_RATE_ROW_RE) ?? []).length >= 2;
  return percentages.length >= 2
    && acronyms.length >= 2
    && hasSwissRateCluster
    && SWISS_RATE_TABLE_RE.test(value);
}

/**
 * `detectWrongLatinLanguage` con la deroga di #1177 applicata al CAMPO.
 *
 * UNICA sorgente della deroga: la usano sia il gate di generazione
 * (`wrongLanguageAdoptions`) sia i tre scan del corpus pubblicato in
 * `generator/tests/wrong-latin-language-adoption.test.mjs`. Due copie
 * divergenti significherebbero un articolo accettato in generazione e rosso
 * per sempre sullo scan — vedi `RATE_TABLE_DEROGATION_FIELDS`.
 *
 * I marker restano attivi: un campo adottato in una lingua diversa continua a
 * essere rifiutato, la deroga vale solo per il segnale morfologico su `it`.
 *
 * @param {string} value
 * @param {string} locale
 * @param {string} field  il nome del campo meta (`title`|`excerpt`|`description`|`ogDescription`|…)
 * @returns {{ lang: string, reason: 'markers'|'morphology' }|null}
 */
export function detectWrongLatinLanguageInField(value, locale, field) {
  const esito = detectWrongLatinLanguage(value, locale);
  if (
    esito
    && locale === 'it'
    && esito.lang === 'non-it'
    && esito.reason === 'morphology'
    && RATE_TABLE_DEROGATION_FIELDS.includes(field)
    && isCompactItalianRateTable(value)
  ) return null;
  return esito;
}
