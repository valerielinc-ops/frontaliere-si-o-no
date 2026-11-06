/**
 * it-microcopy-guard.mjs — guardia DETERMINISTICA su titolo ed excerpt.
 *
 * ## Il difetto che chiude
 *
 * Titolo ed excerpt finiscono in `<title>`, meta description, card dell'hub,
 * RSS e SERP: sono la prima cosa che un lettore vede, e non passano da nessun
 * occhio umano. Misurati il 2026-08-09 su `packages/articles/content/`:
 *
 *   · «Frontaliere gruista ticino: stipendio e requisiti»  (toponimo minuscolo)
 *   · «Sostanzialmente le novità per i frontaliere gruisti in Ticino»
 *   · «I requisiti e il stipendio medio…»                  (articolo su s impura)
 *   · «Quanto guadagna un psicologo frontaliere in Ticino?» (s impura, ps-)
 *
 * `normalizeTitleCasing()` in `scripts/create-article.mjs` conosce gia' i
 * toponimi (`TITLE_CASING_PROPER_NOUNS` contiene 'ticino', create-article.mjs:2524),
 * ma ESCE SUBITO quando il titolo non e' ne' Title Case ne' TUTTO MAIUSCOLO:
 *
 *     if (!looksTitleCase && !isShouting) return s;      // create-article.mjs:2570
 *
 * `looksTitleCase` pretende che almeno il 60% delle parole cominci per
 * maiuscola. «Frontaliere gruista ticino: stipendio e requisiti» ne ha 1 su 6:
 * cade in quel ramo e non raggiunge MAI la tabella dei nomi propri. La tabella
 * non mancava — mancava il percorso per arrivarci. Questa guardia e'
 * INCONDIZIONATA per costruzione: non ha un ramo di uscita anticipata.
 *
 * L'excerpt, dal canto suo, non passava da nessun controllo deterministico in
 * nessuno dei percorsi di pubblicazione di questo repo.
 *
 * ## Cosa NON e'
 *
 * NON e' un correttore grammaticale, e non deve diventarlo. Ogni regola qui
 * dentro e' una funzione totale su un insieme CHIUSO di token, scelta perche'
 * la forma sbagliata non ha NESSUNA lettura corretta in italiano. Tutto cio'
 * che richiede di capire la frase resta fuori, e resta fuori DI PROPOSITO.
 *
 * Le quattro regole, nell'ordine in cui vanno applicate (l'ordine e' vincolante:
 * R3 puo' produrre un plurale che R1 deve poi riarticolare — «i stipendio» →
 * R3 → «i stipendi» → R1 → «gli stipendi»):
 *
 *   R3 `plural-article-singular-noun`  i frontaliere      → i frontalieri
 *   R1 `article-before-impure-s`       il stipendio       → lo stipendio
 *   R2 `toponym-lowercase`             in ticino          → in Ticino
 *   R4 `filler-opener`                 Sostanzialmente X  → X
 *
 * ## Provenienza
 *
 * Porting di `generator/scripts/lib/it-microcopy-guard.mjs` da
 * `nanakokyobashi-rgb/frontaliere-articles#122`. `create-article.mjs` e
 * `publish-journalist-article.mjs` sono `adapted` nel manifest del ciclo, ma le
 * REGOLE qui sotto sono meccanismo puro — nessun percorso, nessun layout — e
 * sono deliberatamente byte-compatibili con quelle del corpus: due copie che
 * divergono su cosa sia un difetto sono peggio di una copia sola.
 *
 * @see tests/it-microcopy-guard.test.ts
 */

// ─────────────────────────────────────────────────────────────────────────────
// R1 — articolo davanti a s impura, z, gn, ps, x, y
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le vocali che DISATTIVANO la regola della s impura, accentate e con dieresi
 * incluse. Senza le accentate «del Säntis» (S + ä) verrebbe letto come s+cons
 * e riscritto in «dello Säntis»: e' un falso positivo osservato sul corpus,
 * non un'ipotesi.
 */
const VOWELS = 'aeiouàáâäãèéêëìíîïòóôöõùúûüh';

/**
 * Consonanti che formano s impura. `s` + vocale (sole, sera) non la forma.
 */
const S_IMPURE_CONSONANTS = 'bcdfgklmnpqrstvwz';

/**
 * `pn` e' ESCLUSO di proposito: «il pneumatico» e «lo pneumatico» sono
 * entrambe forme correnti e accettate, quindi la scelta non e' decidibile
 * senza contesto — ed e' esattamente il tipo di caso che questa guardia non
 * deve toccare. `ps`, `gn`, `z`, `x`, `y` non hanno questa ambiguita'.
 */
const TRIGGER_PREFIXES = [/^ps/, /^gn/, /^z/, /^x/, /^y/];

/** Articoli e preposizioni articolate singolari → forma davanti a s impura. */
export const SINGULAR_ARTICLE_FIXES = Object.freeze({
  il: 'lo', un: 'uno', del: 'dello', nel: 'nello', al: 'allo',
  dal: 'dallo', sul: 'sullo', col: 'collo', quel: 'quello', bel: 'bello',
});

/** Articoli e preposizioni articolate plurali → forma davanti a s impura. */
export const PLURAL_ARTICLE_FIXES = Object.freeze({
  i: 'gli', dei: 'degli', nei: 'negli', ai: 'agli',
  dai: 'dagli', sui: 'sugli', coi: 'cogli', quei: 'quegli',
});

// ─────────────────────────────────────────────────────────────────────────────
// R2 — toponimi noti in minuscolo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Toponimi che NON hanno un omografo comune in italiano: qui la maiuscola e'
 * sempre giusta, in qualunque posizione della frase e in qualunque locale
 * (Ticino resta Ticino anche in un titolo EN/DE/FR — misurati 4 campi FR che
 * si trascinavano il minuscolo dall'italiano attraverso la cascata free-MT).
 */
export const TOPONYMS_UNAMBIGUOUS = Object.freeze(new Set([
  // Cantoni
  'ticino', 'argovia', 'turgovia', 'sciaffusa', 'glarona', 'zugo',
  'friburgo', 'vaud', 'vallese', 'grigioni', 'appenzello', 'neuchâtel',
  // Citta'
  'lugano', 'bellinzona', 'locarno', 'mendrisio', 'zurigo', 'ginevra',
  'basilea', 'losanna', 'berna', 'varese',
  // Paesi
  'italia', 'germania', 'francia', 'austria', 'liechtenstein',
]));

/**
 * Toponimi DELIBERATAMENTE fuori dalla lista sopra, con la ragione. Non e'
 * documentazione decorativa: e' la meta' della regola che le impedisce di
 * diventare un generatore di falsi positivi, ed e' pinnata dal test.
 *
 * `svizzera` da sola vale la maggioranza schiacciante degli hit di un
 * rilevatore ingenuo (138 su 141 misurati sul corpus, tutti usi AGGETTIVALI
 * corretti in minuscolo — «economia svizzera», «busta paga svizzera»):
 * escluderla non e' una rifinitura, e' la decisione che rende la regola
 * applicabile invece che inutilizzabile.
 */
export const TOPONYMS_EXCLUDED_HOMOGRAPHS = Object.freeze({
  svizzera: 'aggettivo di uso comune — «economia svizzera», «busta paga svizzera»: 138 hit su 141 di un rilevatore ingenuo, tutti corretti in minuscolo',
  chiasso: 'sostantivo comune («rumore»), e compare come segmento di slug in `nav:chiasso-border-crossing`',
  soletta: 'sostantivo comune («sottopiede»)',
  lucerna: 'sostantivo comune («lampada a olio»)',
  giura: 'voce del verbo giurare',
  uri: 'due lettere, troppo ambiguo per un match su token',
  svitto: 'confondibile con voci del verbo svitare',
  sangallo: 'ricorre quasi sempre come «San Gallo», due token: un match su token singolo non lo vede',
});

// ─────────────────────────────────────────────────────────────────────────────
// R3 — articolo plurale + sostantivo singolare
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lista CHIUSA di sostantivi maschili singolari che, preceduti da un articolo
 * maschile PLURALE, non hanno nessuna lettura corretta. `frontaliere` e' il
 * caso vivo (misurato: 17 sostituzioni sui campi pubblicati di questo repo),
 * gli altri sono i suoi vicini nello stesso dominio.
 *
 * Solo articoli MASCHILI: «le frontaliere» e' il plurale femminile corretto di
 * «frontaliera» e non va toccato.
 */
export const PLURAL_NOUN_FIXES = Object.freeze({
  frontaliere: 'frontalieri',
  lavoratore: 'lavoratori',
  dipendente: 'dipendenti',
  pendolare: 'pendolari',
  requisito: 'requisiti',
  stipendio: 'stipendi',
  salario: 'salari',
  contratto: 'contratti',
  permesso: 'permessi',
});

const MASCULINE_PLURAL_ARTICLES = ['i', 'gli', 'dei', 'degli', 'nei', 'negli', 'ai', 'agli', 'dai', 'dagli', 'sui', 'sugli', 'quei', 'quegli'];

// ─────────────────────────────────────────────────────────────────────────────
// R4 — attacchi riempitivi
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Solo avverbi di frase e locuzioni che non aggiungono informazione. Le
 * aperture che invece SIGNIFICANO qualcosa («In questo articolo…», «In
 * generale…», «Tutto quello che devi sapere…») sono fuori di proposito:
 * toglierle cambierebbe il testo, non lo ripulirebbe.
 */
export const FILLER_OPENERS = Object.freeze([
  'sostanzialmente', 'fondamentalmente', 'essenzialmente', 'praticamente',
  'ovviamente', 'chiaramente', 'naturalmente', 'semplicemente', 'sicuramente',
  'in sostanza', 'in pratica', 'in buona sostanza', 'di fatto',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const LETTER = '[\\p{L}\\p{M}]';

/**
 * Vero se il token che va da `start` a `end` sta dentro uno slug, un URL o un
 * riferimento `nav:` — dove le minuscole sono SINTASSI e riscriverle romperebbe
 * il link. Il caso vivo e' `nav:chiasso-border-crossing` dentro un excerpt EN.
 */
function isSlugContext(text, start, end) {
  const before = start > 0 ? text[start - 1] : '';
  const after = end < text.length ? text[end] : '';
  if (/[-/_@]/.test(before) || /[-/_@]/.test(after)) return true;
  // "example.ticino" / "ticino.ch"
  if (before === '.' || (after === '.' && /[a-z]/.test(text[end + 1] || ''))) return true;
  // ":" immediatamente prima senza spazio → schema tipo `nav:`
  if (before === ':') return true;
  return false;
}

/** Applica a `replacement` la capitalizzazione iniziale di `original`. */
function matchLeadingCase(original, replacement) {
  if (!original || !replacement) return replacement;
  const isUpper = original[0] === original[0].toUpperCase() && original[0] !== original[0].toLowerCase();
  if (!isUpper) return replacement;
  return replacement[0].toUpperCase() + replacement.slice(1);
}

/** Vero se `word` (minuscolo) comincia per s impura / z / gn / ps / x / y. */
export function startsWithImpureCluster(word) {
  const w = String(word || '').toLowerCase();
  if (w.length < 3) return false;
  if (w[0] === 's' && S_IMPURE_CONSONANTS.includes(w[1]) && !VOWELS.includes(w[1])) return true;
  return TRIGGER_PREFIXES.some((re) => re.test(w));
}

// ─────────────────────────────────────────────────────────────────────────────
// Le quattro regole, come trasformazioni pure su stringa
// ─────────────────────────────────────────────────────────────────────────────

function applyPluralNounAgreement(text, fixes) {
  const arts = MASCULINE_PLURAL_ARTICLES.join('|');
  const nouns = Object.keys(PLURAL_NOUN_FIXES).join('|');
  const re = new RegExp(`(^|[^${LETTER.slice(1, -1)}])(${arts})(\\s+)(${nouns})(?!${LETTER})`, 'gui');
  return text.replace(re, (match, pre, art, gap, noun) => {
    const fixed = PLURAL_NOUN_FIXES[noun.toLowerCase()];
    if (!fixed) return match;
    fixes.push({ rule: 'plural-article-singular-noun', found: `${art} ${noun}`, expected: `${art} ${matchLeadingCase(noun, fixed)}` });
    return `${pre}${art}${gap}${matchLeadingCase(noun, fixed)}`;
  });
}

function applyArticleBeforeImpureS(text, fixes) {
  const all = { ...SINGULAR_ARTICLE_FIXES, ...PLURAL_ARTICLE_FIXES };
  const arts = Object.keys(all).join('|');
  const re = new RegExp(`(^|[^${LETTER.slice(1, -1)}])(${arts})(\\s+)(${LETTER}+)`, 'gui');
  return text.replace(re, (match, pre, art, gap, noun, offset) => {
    // Il sostantivo DEVE essere minuscolo. E' la condizione che tiene fuori
    // «il PS», «dal PNRR», «il Swiss Market Index»: sigle e nomi propri hanno
    // regole loro e riscriverli sarebbe un errore, non una correzione.
    if (noun[0] !== noun[0].toLowerCase() || noun[0] === noun[0].toUpperCase()) return match;
    if (!startsWithImpureCluster(noun)) return match;
    const nounStart = offset + pre.length + art.length + gap.length;
    if (isSlugContext(text, nounStart, nounStart + noun.length)) return match;
    const fixed = all[art.toLowerCase()];
    if (!fixed) return match;
    fixes.push({ rule: 'article-before-impure-s', found: `${art} ${noun}`, expected: `${matchLeadingCase(art, fixed)} ${noun}` });
    return `${pre}${matchLeadingCase(art, fixed)}${gap}${noun}`;
  });
}

function applyToponymCasing(text, fixes) {
  const re = new RegExp(`${LETTER}+`, 'gu');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const token = m[0];
    if (token === token.toLowerCase() && TOPONYMS_UNAMBIGUOUS.has(token) && !isSlugContext(text, m.index, m.index + token.length)) {
      const fixed = token[0].toUpperCase() + token.slice(1);
      fixes.push({ rule: 'toponym-lowercase', found: token, expected: fixed });
      out += text.slice(last, m.index) + fixed;
      last = m.index + token.length;
    }
  }
  return out + text.slice(last);
}

function applyFillerOpener(text, fixes) {
  const openers = FILLER_OPENERS.join('|');
  const re = new RegExp(`^\\s*(${openers})\\s*,?\\s+(?=${LETTER})`, 'iu');
  const m = text.match(re);
  if (!m) return text;
  const rest = text.slice(m[0].length);
  // Se togliendo l'attacco non resta un excerpt utile, meglio lasciarlo com'e'
  // che pubblicarne un moncone.
  if (rest.length < 40) return text;
  fixes.push({ rule: 'filler-opener', found: m[1], expected: '(rimosso)' });
  return rest[0].toUpperCase() + rest.slice(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// API pubblica
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Riscrive `text` applicando le regole decidibili. Idempotente: rieseguirla
 * sull'output non produce altre modifiche.
 *
 * @param {string} text
 * @param {{ locale?: string, field?: 'title'|'excerpt' }} [opts]
 *        `locale` diverso da 'it' esegue SOLO R2 (la maiuscola di un toponimo
 *        vale in ogni lingua; la grammatica italiana no).
 *        R4 si applica solo a `field: 'excerpt'`.
 * @returns {{ value: string, fixes: Array<{rule: string, found: string, expected: string}> }}
 */
export function fixMicrocopy(text, opts = {}) {
  const { locale = 'it', field = 'title' } = opts;
  const input = String(text ?? '');
  if (!input.trim()) return { value: input, fixes: [] };
  const fixes = [];
  let out = input;
  if (locale === 'it') {
    out = applyPluralNounAgreement(out, fixes);
    out = applyArticleBeforeImpureS(out, fixes);
  }
  out = applyToponymCasing(out, fixes);
  if (locale === 'it' && field === 'excerpt') out = applyFillerOpener(out, fixes);
  return { value: out, fixes };
}

/**
 * Sola diagnosi, senza riscrittura — la forma che serve al gate sull'output
 * pubblicato. `fixMicrocopy` e' l'unica implementazione: un rilevatore scritto
 * a parte diverge dal correttore, e allora il gate smette di descriverlo.
 *
 * @returns {Array<{rule: string, found: string, expected: string}>}
 */
export function findMicrocopyDefects(text, opts = {}) {
  return fixMicrocopy(text, opts).fixes;
}
