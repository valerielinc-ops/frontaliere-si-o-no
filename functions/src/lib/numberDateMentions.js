/**
 * The quantities and dates a text states in words, in Italian, German, French and English: what a
 * generated answer may not claim unless the CV states it too (assistedApplicationCvAnswers.js).
 *
 *   - digits (any run of them) and percentages;
 *   - cardinal numbers written in words, compounds included («ventidue», «zweiundzwanzig»,
 *     «dix-sept», «twenty-two», «trecento»), the approximate quantities («decine», «Hunderte»,
 *     «dozens», «centaines») and the multiplicatives («twice», «dreimal»);
 *   - the words that are also an article or another word («un/une/uno/una/ein/one/a/an», «due», «sei»,
 *     «seize», «cent», «null»): a number only before a unit of time or a count of times
 *     («un an», «ein Jahr», «one month», «una volta»), never before anything else («un projet»);
 *   - months (full names; the abbreviations next to a figure; «mai/may/mars/march» only in a date
 *     context: «en mai», «in May», «im Mai», «a marzo» is a month anyway), weekdays and relative dates
 *     («l'anno scorso», «last year», «letztes Jahr», «l'année dernière»).
 *
 * Ordinals («primo», «first», «zweite») are not read: in prose they order the sentence far more often
 * than they count. Pure JavaScript, no lookbehind.
 */

const fold = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/ß/g, 'ss').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Number morphemes and their value. `alone: false`: only inside a compound («vent» of «ventidue»).
const MORPHEMES = [
  // Italian
  ['zero', 0], ['uno', 1, false], ['una', 1, false], ['un', 1, false], ['due', 2, false], ['tre', 3], ['quattro', 4], ['cinque', 5],
  ['sei', 6, false], ['sette', 7], ['otto', 8], ['nove', 9], ['dieci', 10], ['undici', 11], ['dodici', 12], ['tredici', 13],
  ['quattordici', 14], ['quindici', 15], ['sedici', 16], ['diciassette', 17], ['diciotto', 18], ['diciannove', 19],
  ['venti', 20], ['vent', 20, false], ['trenta', 30], ['trent', 30, false], ['quaranta', 40], ['quarant', 40, false],
  ['cinquanta', 50], ['cinquant', 50, false], ['sessanta', 60], ['sessant', 60, false], ['settanta', 70], ['settant', 70, false],
  ['ottanta', 80], ['ottant', 80, false], ['novanta', 90], ['novant', 90, false], ['cento', 100], ['mille', 1000],
  ['mila', 1000, false], ['milione', 1e6], ['milioni', 1e6], ['miliardo', 1e9], ['miliardi', 1e9],
  // English
  ['one', 1, false], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9],
  ['ten', 10], ['eleven', 11], ['twelve', 12], ['thirteen', 13], ['fourteen', 14], ['fifteen', 15], ['sixteen', 16],
  ['seventeen', 17], ['eighteen', 18], ['nineteen', 19], ['twenty', 20], ['thirty', 30], ['forty', 40], ['fifty', 50],
  ['sixty', 60], ['seventy', 70], ['eighty', 80], ['ninety', 90], ['hundred', 100], ['thousand', 1000], ['million', 1e6],
  ['billion', 1e9], ['twice', 2], ['thrice', 3],
  // German
  ['null', 0, false], ['eins', 1], ['ein', 1, false], ['eine', 1, false], ['zwei', 2], ['drei', 3], ['vier', 4], ['funf', 5],
  ['fuenf', 5], ['sechs', 6], ['sech', 6, false], ['sieben', 7], ['sieb', 7, false], ['acht', 8], ['neun', 9], ['zehn', 10],
  ['elf', 11], ['zwolf', 12], ['zwoelf', 12], ['zwanzig', 20], ['dreissig', 30], ['vierzig', 40], ['funfzig', 50],
  ['sechzig', 60], ['siebzig', 70], ['achtzig', 80], ['neunzig', 90], ['hundert', 100], ['tausend', 1000],
  ['millionen', 1e6], ['milliarde', 1e9], ['milliarden', 1e9], ['und', 0, false], ['mal', 0, false],
  // French
  ['une', 1, false], ['deux', 2], ['trois', 3], ['quatre', 4], ['cinq', 5], ['sept', 7], ['huit', 8], ['neuf', 9],
  ['dix', 10], ['onze', 11], ['douze', 12], ['treize', 13], ['quatorze', 14], ['quinze', 15], ['seize', 16, false],
  ['vingt', 20], ['vingts', 20], ['trente', 30], ['quarante', 40], ['cinquante', 50], ['soixante', 60], ['quatrevingt', 80],
  ['cent', 100, false], ['cents', 100], ['millions', 1e6], ['milliard', 1e9], ['milliards', 1e9],
];
const BY_FORM = new Map();
for (const [form, value, alone = true] of MORPHEMES) {
  const known = BY_FORM.get(form);
  // A form shared by two languages is alone-able only if every language lets it stand alone.
  BY_FORM.set(form, { value, alone: known ? known.alone && alone : alone });
}
const FORMS = [...BY_FORM.keys()].sort((left, right) => right.length - left.length);
const CONNECTORS = new Set(['und', 'mal']);

// Approximate quantities: a number claim of their own.
const QUANTITY_WORDS = new Set(['decina', 'decine', 'dozzina', 'dozzine', 'centinaio', 'centinaia', 'migliaio', 'migliaia',
  'dozen', 'dozens', 'hundreds', 'thousands', 'millions', 'dutzend', 'dutzende', 'hunderte', 'tausende', 'dizaine', 'dizaines',
  'douzaine', 'douzaines', 'centaine', 'centaines', 'millier', 'milliers']);
// After an article-shaped number only these make it a count: a span of time, or a number of times.
const UNIT_CLASSES = {
  year: ['anno', 'anni', 'year', 'years', 'jahr', 'jahre', 'jahren', 'jahres', 'an', 'ans', 'annee', 'annees'],
  month: ['mese', 'mesi', 'month', 'months', 'monat', 'monate', 'monaten', 'monats', 'mois'],
  week: ['settimana', 'settimane', 'week', 'weeks', 'woche', 'wochen', 'semaine', 'semaines'],
  day: ['giorno', 'giorni', 'day', 'days', 'tag', 'tage', 'tagen', 'jour', 'jours', 'journee'],
  hour: ['ora', 'ore', 'hour', 'hours', 'stunde', 'stunden', 'heure', 'heures'],
  minute: ['minuto', 'minuti', 'minute', 'minutes', 'minuten'],
  times: ['volta', 'volte', 'mal', 'fois'],
  decade: ['decennio', 'decade', 'jahrzehnt', 'decennie'],
  semester: ['semestre', 'semester'],
};
const UNIT_OF = new Map(Object.entries(UNIT_CLASSES).flatMap(([unit, forms]) => forms.map((form) => [form, unit])));
const ARTICLES = new Set(['un', 'uno', 'una', 'une', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines', 'one', 'a', 'an']);

const MONTH_NAMES = [
  ['gennaio', 'january', 'januar', 'janvier', 'jaenner', 'janner'],
  ['febbraio', 'february', 'februar', 'fevrier'],
  ['marzo', 'march', 'marz', 'maerz', 'mars'],
  ['aprile', 'april', 'avril'],
  ['maggio', 'may', 'mai'],
  ['giugno', 'june', 'juni', 'juin'],
  ['luglio', 'july', 'juli', 'juillet'],
  ['agosto', 'august', 'aout'],
  ['settembre', 'september', 'septembre'],
  ['ottobre', 'october', 'oktober', 'octobre'],
  ['novembre', 'november'],
  ['dicembre', 'december', 'dezember', 'decembre'],
];
const MONTH_ABBREVIATIONS = [
  ['gen', 'jan', 'janv'], ['feb', 'febr', 'fevr'], ['mar', 'maer'], ['apr', 'avr'], ['mag'], ['giu', 'jun'],
  ['lug', 'jul', 'juil'], ['ago', 'aug'], ['set', 'sep', 'sept'], ['ott', 'oct', 'okt'], ['nov'], ['dic', 'dec', 'dez'],
];
const MONTH_OF = new Map();
MONTH_NAMES.forEach((names, index) => names.forEach((name) => MONTH_OF.set(name, index + 1)));
const ABBREVIATION_OF = new Map();
MONTH_ABBREVIATIONS.forEach((names, index) => names.forEach((name) => ABBREVIATION_OF.set(name, index + 1)));
// Month names that are also another word: «mai» (it: never), «may» (en: modal), «mars», «march» (verb).
const AMBIGUOUS_MONTHS = new Set(['mai', 'may', 'mars', 'march']);
const DATE_CONTEXT_BEFORE = new Set(['en', 'in', 'im', 'au', 'a', 'de', 'di', 'del', 'of', 'since', 'seit', 'depuis', 'ab', 'bis',
  'until', 'vom', 'jusqu', 'fin', 'debut', 'inizio', 'fine', 'end', 'early', 'late', 'mid', 'anfang', 'ende', 'mitte', 'mois',
  'month', 'monat', 'mese', 'dal', 'al', 'from', 'to', 'le', 'des', 'du', 'dem', 'des', 'next', 'last']);
const WEEKDAYS = new Set(['lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato', 'domenica',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag', 'sonnabend', 'sonntag',
  'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']);
const RELATIVE_DATE = /\b(?:(?:last|past|previous|next|this) (?:year|month|week|summer|winter|spring|autumn|fall)|(?:anno|mese|settimana|estate|inverno|primavera|autunno) (?:scors[oa]|passat[oa]|prossim[oa])|(?:scors[oa]|passat[oa]|prossim[oa]) (?:anno|mese|settimana|estate|inverno)|(?:letzte[nmrs]?|vergangene[nmrs]?|nachste[nmrs]?|diese[nmrs]?) (?:jahr|monat|woche|sommer|winter|fruhling|herbst)|(?:an|annee|mois|semaine|ete|hiver) (?:dernier|derniere|passe|passee|prochain|prochaine)|(?:yesterday|ieri|gestern|hier)|\d+ (?:years?|months?|weeks?) ago)\b/g;

// Words that are a number only before a unit: articles, and «due» (en), «sei» (it), «seize» (en), «cent» (en),
// «null» (en), «one» («one of the…»).
const ARTICLE_LIKE = new Set([...ARTICLES, 'due', 'sei', 'seize', 'cent', 'null']);

/** The value of the morphemes of a compound: «trecento» 300, «zweiundzwanzig» 22, «duemila» 2000. */
function compoundValue(parts) {
  let total = 0;
  let current = 0;
  for (const part of parts) {
    const value = BY_FORM.get(part).value;
    if (CONNECTORS.has(part)) continue;
    if (value === 100) current = (current || 1) * 100;
    else if (value >= 1000) { total += (current || 1) * value; current = 0; } else current += value;
  }
  return total + current;
}

/**
 * A whole word that is a number: its value and, for a multiplicative («dreimal», «twice»), the unit
 * `times`; undefined when it is none.
 */
function wordNumber(word) {
  if (word === 'twice' || word === 'thrice') return { value: BY_FORM.get(word).value, unit: 'times' };
  const direct = BY_FORM.get(word);
  if (direct) return direct.alone && !CONNECTORS.has(word) ? { value: direct.value } : undefined;
  if (word.length < 5) return undefined;
  // Cut the word into morphemes: at least two, not connectors only, not «einmal» («once», «just»).
  const cut = (rest) => {
    if (!rest) return [];
    for (const form of FORMS) {
      if (!rest.startsWith(form)) continue;
      const tail = cut(rest.slice(form.length));
      if (tail) return [form, ...tail];
    }
    return null;
  };
  const parts = cut(word);
  if (!parts || parts.length < 2 || parts.every((part) => CONNECTORS.has(part))) return undefined;
  const times = parts.at(-1) === 'mal';
  if (times && parts.length === 2 && ARTICLE_LIKE.has(parts[0])) return undefined;
  return { value: compoundValue(times ? parts.slice(0, -1) : parts), ...(times ? { unit: 'times' } : {}) };
}

/**
 * The number and date mentions of a text.
 * @param {string} text
 * @returns {Array<{kind:'number'|'date', token:string, key:string}>} `key` compares a mention across
 *   languages and forms: «due anni», «2 anni» and «two years» share `n:2:year`, «tre» and «3» share
 *   `n:3`, «mai» and «maggio» share `m:5`
 */
export function numberDateMentions(text) {
  const raw = String(text ?? '');
  const out = [];
  const add = (kind, token, key) => { if (!out.some((item) => item.key === key)) out.push({ kind, token, key }); };
  const numberKey = (value, next, unit = UNIT_OF.get(next)) => (unit ? `n:${value}:${unit}` : `n:${value}`);
  if (/%|\bper ?cento\b|\bpercent\w*\b|\bprozent\w*\b|\bpour ?cent\b/i.test(raw)) add('number', '%', 'percent');
  // A hyphenated number is one word («dix-sept», «twenty-two»); any other hyphenated word is its parts.
  const words = raw.split(/[^\p{L}\p{N}‐‑-]+/u).filter(Boolean).flatMap((piece) => {
    const joined = fold(piece.replace(/[-‐‑]/g, ''));
    return /[-‐‑]/.test(piece) && wordNumber(joined) ? [joined] : fold(piece).split(' ').filter(Boolean);
  });
  for (const list of [words]) {
    list.forEach((word, index) => {
      const next = list[index + 1] || '';
      const previous = list[index - 1] || '';
      if (/^\d+$/.test(word)) {
        add('number', word, numberKey(Number(word), next));
        return;
      }
      if (QUANTITY_WORDS.has(word)) { add('number', word, `q:${word}`); return; }
      if (ARTICLE_LIKE.has(word)) {
        // «una volta», «une fois» before an episode mean «once», not a count: only a span of time counts.
        if (UNIT_OF.has(next) && UNIT_OF.get(next) !== 'times') add('number', `${word} ${next}`, numberKey(BY_FORM.get(word)?.value ?? 1, next));
        return;
      }
      // «sept» next to a figure is September («12 sept 2020»), read as a month below.
      const number = word === 'sept' && (/^\d/.test(next) || /^\d/.test(previous)) ? undefined : wordNumber(word);
      if (number) add('number', word, numberKey(number.value, next, number.unit));
      if (MONTH_OF.has(word)) {
        const contextual = !AMBIGUOUS_MONTHS.has(word) || DATE_CONTEXT_BEFORE.has(previous) || /^\d/.test(previous) || /^\d/.test(next);
        if (contextual) add('date', word, `m:${MONTH_OF.get(word)}`);
      } else if (ABBREVIATION_OF.has(word) && (/^\d/.test(previous) || /^\d/.test(next))) {
        add('date', word, `m:${ABBREVIATION_OF.get(word)}`);
      }
      if (WEEKDAYS.has(word)) add('date', word, `d:${word}`);
    });
  }
  for (const match of fold(raw).matchAll(RELATIVE_DATE)) add('date', match[0], `r:${match[0]}`);
  return out;
}

/**
 * The mentions of `text` that `source` does not state. A figure without a unit is backed by the same
 * figure anywhere in the source; one with a unit («2 anni») only by the same figure with the same unit.
 * @returns {Array<{kind:'number'|'date', token:string}>}
 */
export function unsupportedNumberDateMentions(text, source) {
  const backed = new Set();
  for (const mention of numberDateMentions(source)) {
    backed.add(mention.key);
    // «2 anni» in the CV backs a bare «due» or «2» too.
    if (/^n:[^:]+:/.test(mention.key)) backed.add(mention.key.replace(/^(n:[^:]+):.*$/, '$1'));
  }
  return numberDateMentions(text).filter((mention) => !backed.has(mention.key))
    .map(({ kind, token }) => ({ kind, token }));
}
