/**
 * Deterministic fact gate for AI-written application texts.
 *
 * Idea taken from career-ops' verify-cv-facts (MIT): a generated document may
 * reformulate the candidate's CV but never introduce a fact the sources do
 * not contain. Language-agnostic by construction — it checks the tokens a
 * model most often invents or "rounds" (numbers, years, percentages, e-mail
 * addresses, URLs, phone numbers, and tools: verify-cv-facts' `isLikelyTool`),
 * not prose. A failing gate does not block the draft: it lists each
 * unsupported token so the operator fixes or confirms it before anything
 * reaches an employer.
 *
 * Study 2026-10-02 (report-cv-lettera §5, §8): three holes of the port closed
 * here, measured on 17 synthetic cases (8 right before, 13 with the first fix,
 * all with this one):
 *   - a tool written as a plain word ("Kubernetes") is a claim too: the closed
 *     vocabulary of lib/toolVocabulary.js names them, with their aliases;
 *   - in the candidate's own texts a number comes from the candidate, never
 *     from the posting ("un team di 5" where only the posting says 5), unless
 *     the sentence quotes the requirement ("pur non avendo i 5 anni richiesti");
 *   - an employer or a job title the sources never name is blocked; a
 *     capitalised word the text only echoes from the posting is reported to
 *     the operator as an advisory, not blocked ("Semester", "Profil").
 *
 * False alarms closed on 2026-10-03 (a real order: six flags, nothing invented;
 * each one stops the draft at the owner and discards the tailored CV):
 *   - a PDF text layer that glues a token to the next word ("B1Intermedio"):
 *     the capital that starts a word is a boundary in the candidate's raw text;
 *   - a name that ran into the next sentence ("at Svag. Previously, I was…");
 *   - "as well as English" read as a job title, and a language named in the
 *     letter's language ("English") where the CV says "inglese" (the name as a
 *     whole word: "machine learning" holds no "Chinese");
 *   - a tool the posting names, quoted as something still to learn ("motivated
 *     to learn the hotel's LQA and Forbes standards"), is no claim of having it.
 *
 * Repair of 2026-10-03/04 (close-out of the study): two of those exemptions let
 * invented claims through, and one hole was there from the start:
 *   - the gap: one learn verb in any tense, or one bare negation, in the
 *     clause was enough ("I learned Kubernetes and AWS in my last job", "Ich
 *     setze Kubernetes ohne Probleme produktiv ein", "J'ai pu apprendre
 *     Kubernetes", "Non ho difficoltà a lavorare con SAP" passed). Lists of
 *     cue words, or a template closed only around the tool, let through what
 *     they do not foresee ("I wouldn't say I'm new to SAP", "I have no
 *     experience with SAP, outside of a two-day workshop"), so the whole
 *     sentence is closed now (lib/honestGap.js): it keeps its gaps only when
 *     it splits into closed templates (a lack, a wish to learn, a pronoun that
 *     learns the tool, a neutral clause); anything else in it, even a piece
 *     about a tool the CV backs, makes every tool of it a claim, as before the
 *     exemption. What passes is reported as a `gap` advisory, so the owner sees
 *     it. Probed with the twelve probe sets of the close-out and the 442 claims
 *     of two adversarial reviews: no claim passes; 11 of their 80 natural
 *     honest gaps are false alarms the owner confirms, most of them a gap in a
 *     sentence that says something else too (3 of the first 40, against 15 at
 *     HEAD). The letter prompt asks for a gap in a short sentence of its own;
 *   - the glued token: any capital after it was a boundary, so "JavaScript"
 *     backed "Java" and "GoPro" backed "Go", in the tailored CV too
 *     (backsClaim is shared). Now only a token with a digit, or one before a
 *     level word ("ExcelAvanzato") that does not end a longer name with it
 *     ("ReactNative");
 *   - the digits of a phone number, an e-mail address or a link in the
 *     candidate's texts and in the order line backed any equal figure ("un
 *     team di 45 persone"), in the letter and in the tailored CV: contact
 *     data is taken out before the candidate's numbers are read (phoneNumbers
 *     reads the formats a CV writes, never a date, a year after the number
 *     or a figure of nine digits), and is no figure in the checked text either
 *     (the e-mail is signed with the candidate's phone and may quote the CV's
 *     link without its scheme); the candidate's own number is no unknown phone
 *     in another format ("079 …" in the CV, "+41 79 …" in the signature).
 */

import { gapReader } from './lib/honestGap.js';
import { mentionsVocabularyTool, vocabularyTools } from './lib/toolVocabulary.js';

const NUMBER_RE = /\d(?:[\d'’.,  ]*\d)?/g;
// From the start of the address only: without the look-behind every character of a long word restarts it.
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()"']+/gi;
const PHONE_RE = /(?:\+|00)\d[\d\s/.-]{7,}\d/g;
// A link written without its scheme: with a path ("linkedin.com/in/…"), or a bare domain under a common
// top-level domain ("mariarossi4521.ch").
const BARE_URL_RE = /(?<![\p{L}\p{N}@.])(?:[a-z0-9-]+\.)+(?:[a-z]{2,}\/[^\s<>()"']*|(?:ch|li|it|de|at|fr|com|net|org|eu|io|info|biz|co|uk|me|dev|app)(?![\p{L}\p{N}]))/giu;
// A run of digit groups as a phone number is written: groups split by one space of any width (never a
// line break), a dot, or a hyphen or a slash with or without spaces ("091 / 123 45 67"); a prefix
// ("+41", "0041", "(+41)") and a trunk zero in brackets ("(0)79") only at the start or after the prefix. A
// label may be glued to it ("Tel.079 …"), a digit never. phoneNumbers reads which part of it is a number.
const PHONE_SEPARATOR = String.raw`(?:[^\S\n]?[\/-][^\S\n]?|[^\S\n]|\.)`;
const PHONE_RUN_RE = new RegExp(String.raw`(?<![\p{L}\p{N}])(?<!\p{N}[.,'’/-])(?:\(?(?:\+|00)\d{1,3}\)?|\(0\)[^\S\n]?\d|\(?\d)[\d()]*(?:${PHONE_SEPARATOR}\(?\d[\d()]*)*(?!\d)`, 'gu');
const PHONE_GROUP_RE = new RegExp(String.raw`\(?(?:\+|00)?\d[\d()]*|\(0\)`, 'gu');
// A date at the start of a run ("03.2005", "01.03.2021", "(03/2021"), or in it: never a phone number.
const DATE_START_RE = /^\(?\d{1,2}[./-](?:\d{1,2}[./-])?(?:19|20)\d{2}(?!\d)/;
const DATE_IN_RE = /(?<!\d)\d{1,2}[./](?:\d{1,2}[./])?(?:19|20)\d{2}(?!\d)/;
const YEAR_GROUP_RE = /^(?:19|20)\d{2}$/;
// The label a CV writes before a phone number: after it, a number of seven digits or more is one, even
// without a trunk zero ("Tel. 234 56 78" in Liechtenstein).
const PHONE_LABEL_RE = /(?:^|[^\p{L}])(?:tel|tél|telefon|telefono|téléphone|phone|mobile|mobil|natel|handy|cell|cellulare|portable|fax)\.?[^\S\n]*[:/]?[^\S\n]*$/iu;
// The posting's reference the e-mail subject keeps ("réf. INF-2026-17",
// assistedApplicationAiPrompts.js): its letters are the employer's, not a tool.
const REFERENCE_RE = /\b(?:rif|ref|réf|riferimento|référence|reference|kennziffer|referenznummer|referenz|job[- ]?id|stellen-?id)\b\.?\s*[:#]?\s*[A-Z0-9/_.-]*\d[A-Z0-9/_.-]*/gi;

// Letters and digits, read across a "/" (toolTokens decides whether it binds); everything else splits.
const WORD_RE = /[\p{L}\p{N}]+(?:\/[\p{L}\p{N}]+)*/gu;
// Tool-shaped tokens that are never a claim about the candidate: what every
// application names (CV, HR), money, legal forms, places (Swiss canton codes;
// "AI" is left out, it is also a skill), LinkedIn.
const NOT_A_CLAIM = new Set([
  'CV', 'HR', 'RH', 'PDF', 'PS', 'CHF', 'EUR', 'SA', 'AG', 'GmbH', 'SAGL', 'SRL', 'SpA', 'LinkedIn', 'CH', 'EU', 'UE',
  'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE', 'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH',
]);
const ROMAN_RE = /^(?:I{2,3}|IV|VI{0,3}|IX|XI{0,2})$/; // "Master di II livello"
const YEAR_RE = /^(?:19|20)\d\d$/;

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeUrl(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/.,;:!?)]+$/, '');
}

function contextAround(text, index, length) {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The same sign, as a posting and a generated text write it: «d'opérateur·trice» is «d’opérateur∙trice».
const SIGN_VARIANTS = ["'’‘ʼ`´", '·∙•‧⋅', '-‐‑‒–—'];

/**
 * A name (the job title, the company, the place) wherever a text quotes it
 * whole, whatever its typography and spacing. An apprenticeship «…
 * d'opérateur·trice en informatique CFC» (2026-10-03) was quoted with a
 * typographic apostrophe: the title went unrecognised and its own «CFC» was
 * taken for a skill the CV does not show.
 */
function nameRegExp(name) {
  const source = [...name].map((char) => {
    const variants = SIGN_VARIANTS.find((signs) => signs.includes(char));
    return variants ? `[${variants}]` : escapeRegExp(char);
  }).join('').replace(/\s+/g, '\\s+');
  return new RegExp(source, 'giu');
}

/** Lowercase without accents: the form a text is searched for tools in. */
export function foldText(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function toolShape(word) {
  if (/^\p{Lu}{2,}s?$/u.test(word)) return ROMAN_RE.test(word) ? '' : 'acronym';
  if (/^\p{Lu}/u.test(word) && /\p{N}/u.test(word)) return 'digit';
  // An inner capital, unless it is the German "Binnen-I" (MitarbeiterInnen).
  if (/\p{Ll}\p{Lu}/u.test(word) && !/\p{Ll}In(?:nen)?$/u.test(word)) return 'camel';
  return '';
}

/**
 * Tool-like tokens of a text (career-ops `isLikelyTool`): an acronym of two
 * capitals or more (SAP, BLS, ACLS), a word that starts with a capital and
 * carries a digit (S/4HANA, Office365, B2) or one with an inner capital
 * (PowerPoint, SolidWorks). An acronym followed by a number is one token
 * ("ISO 9001"), so a CV with ISO 9001 does not back an ISO 13485. A
 * capitalised word alone (a sentence start, a German noun, a place,
 * "Salesforce") is prose, never a tool.
 * @returns {Array<{token:string, index:number, length:number}>}
 */
export function toolTokens(text) {
  const source = String(text || '');
  const words = [];
  for (const match of source.matchAll(WORD_RE)) {
    // "S/4HANA" is one name; "SAP/ERP" and "Infermiere/a" are two words.
    const parts = /\p{N}/u.test(match[0]) ? [match[0]] : match[0].split('/');
    let offset = match.index;
    for (const part of parts) {
      words.push({ word: part, index: offset });
      offset += part.length + 1;
    }
  }
  const out = [];
  for (let position = 0; position < words.length; position += 1) {
    const { word, index } = words[position];
    const shape = toolShape(word);
    if (!shape || NOT_A_CLAIM.has(shape === 'acronym' ? word.replace(/s$/, '') : word)) continue;
    const next = words[position + 1];
    const gap = next ? source.slice(index + word.length, next.index) : '';
    if (shape === 'acronym' && /^[\s-]$/u.test(gap) && /^\d+$/.test(next.word) && !YEAR_RE.test(next.word)) {
      out.push({ token: `${word} ${next.word}`, index, length: next.index + next.word.length - index });
      position += 1;
      continue;
    }
    out.push({ token: word, index, length: word.length });
  }
  return out;
}

/**
 * Every claim of a tool in a text: the shape rule of toolTokens plus the closed
 * vocabulary, which sees the tools a shape cannot ("Kubernetes", "Excel").
 * Where both see the same span the vocabulary wins, so its aliases apply.
 * @returns {Array<{token:string, index:number, length:number, name?:string}>}
 */
export function claimTokens(text) {
  const vocabulary = vocabularyTools(text);
  const overlaps = (index, length) => vocabulary.some((hit) => index < hit.index + hit.length && index + length > hit.index);
  const shaped = toolTokens(text).filter(({ index, length }) => !overlaps(index, length));
  return [...vocabulary, ...shaped].sort((left, right) => left.index - right.index);
}

// The word a CV's table writes next to a language or a tool: its level, in the four languages.
const LEVEL_WORDS = 'Intermedio|Avanzato|Base|Elementare|Ottimo|Buono|Fluente|Madrelingua|Scolastico'
  + '|Advanced|Intermediate|Basic|Beginner|Fluent|Native|Proficient'
  + '|Gut|Sehr|Fliessend|Fließend|Fortgeschritten|Grundkenntnisse|Muttersprache|Verhandlungssicher'
  + '|Courant|Avancé|Intermédiaire|Débutant|Bon|Maternelle|Notions';

/**
 * A PDF text layer may glue a token to the word after it ("B1Intermedio:",
 * the column of a table): in the raw text the capital that starts that word
 * is a boundary. Only for a token that carries a digit (a level, "ISO 9001"),
 * or before a level word ("ExcelAvanzato") that does not end a longer name
 * with it ("ReactNative"): any capital would make the start of a longer name
 * back the shorter one ("Java" in "JavaScript", "Go" in "GoPro"). Never a
 * lowercase run ("B1x") nor a digit ("B12").
 */
function gluedInRaw(raw, token) {
  const source = String(raw || '');
  const name = escapeRegExp(String(token));
  if (/\p{N}/u.test(String(token))) return new RegExp(`(?<![\\p{L}\\p{N}])${name}(?=\\p{Lu}\\p{Ll})`, 'u').test(source);
  // A level word that also ends a longer name is that name: "ReactNative" is React Native, not React.
  const glued = new RegExp(`(?<![\\p{L}\\p{N}])${name}(${LEVEL_WORDS})(?![\\p{L}\\p{N}])`, 'gu');
  return [...source.matchAll(glued)].some((match) => !namesOneTool(`${token} ${match[1]}`));
}
const namesOneTool = (phrase) => vocabularyTools(phrase).some((hit) => hit.index === 0 && hit.length === phrase.length);

/** Whether the candidate's texts back a claim token (by its vocabulary aliases when it has a name). */
export function backsClaim({ folded, raw }, claim) {
  if (claim.name && mentionsVocabularyTool(raw, claim.name)) return true;
  return mentionsTool(folded, claim.token) || gluedInRaw(raw, claim.token);
}

/**
 * Whether a folded text (foldText, or the ATS check's normalizeText) names a
 * tool: as a whole word, with or without the separators inside it ("S/4 HANA",
 * "ISO-9001", "Power Point"), singular or plural ("KPIs").
 */
export function mentionsTool(foldedText, token) {
  const runs = String(token).replace(/(?<=\p{Lu})s$/u, '')
    .split(/[^\p{L}\p{N}]+|(?<=\p{Ll})(?=\p{Lu})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u)
    .filter(Boolean)
    .map((run) => escapeRegExp(foldText(run)));
  return new RegExp(`(?<![a-z0-9])${runs.join('[\\s/._-]{0,2}')}s?(?![a-z0-9])`).test(foldedText);
}

/** Every number a text gives, whole and by its parts ("2'500" gives 2500, 2 and 500). */
export function numbersOf(text) {
  const numbers = new Set();
  for (const match of String(text || '').matchAll(NUMBER_RE)) {
    const digits = digitsOnly(match[0]);
    if (digits) numbers.add(digits);
    // "2'500" and "2.500,50" also contribute their parts ("2", "500").
    for (const part of match[0].split(/[^\d]+/)) if (part) numbers.add(part);
  }
  return numbers;
}

// Invisible characters (a soft hyphen, a zero-width space, a byte-order mark) and the rare apostrophes are
// taken out of every text the gate reads, sources and generated texts alike: "SA\u00ADP" is SAP.
const visible = (value) => String(value || '').replace(/\p{Cf}/gu, '').replace(/[ʼʻ´`＇]/g, "'");
const join = (texts) => (texts || []).filter(Boolean).map(visible).join('\n');
const wordsOf = (text) => new Set(foldText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean));

/** Each line of a text with the offset it starts at. */
function lineStarts(text) {
  let offset = 0;
  return String(text || '').split('\n').map((line) => {
    const start = offset;
    offset += line.length + 1;
    return [line, start];
  });
}

/**
 * The phone numbers of one line, as a CV writes them: with a prefix ("+41 79 123 45 67", "0041 …",
 * "+41 (0)79 …", "(+41) 79 …"), from the trunk zero ("079 123 45 67", "(091) 123 45 67", "(0)79 123 45 67",
 * "0151 1234 5678", "06 12 34 56 78") or as a ten-digit Italian mobile ("333 1234567", "347.1234567"). A
 * number ends where a Swiss number is whole (0xx xxx xx xx, +41 xx xxx xx xx), before a year that follows
 * a long enough number ("091 123 45 67 2015 – 2017"), and before a group that would make it too long; a
 * date is none ("03.2005 - 12.2009"), nor a figure with nine digits ("300.000.000", "CHF 320 000 000").
 * @returns {Array<{index:number, length:number, key:string}>} key: the last nine digits, as index.phones keeps a number
 */
function phoneNumbers(line) {
  const found = [];
  for (const run of String(line || '').matchAll(PHONE_RUN_RE)) {
    const groups = [...run[0].matchAll(PHONE_GROUP_RE)].map((match) => ({
      text: match[0],
      start: run.index + match.index,
      end: run.index + match.index + match[0].length,
    }));
    const labelled = PHONE_LABEL_RE.test(String(line).slice(Math.max(0, run.index - 16), run.index));
    let first = 0;
    while (first < groups.length) {
      const number = readPhone(groups, first, run[0].slice(groups[first].start - run.index), first === 0 && labelled);
      if (!number) { first += 1; continue; }
      found.push(number.phone);
      first = number.next;
    }
  }
  return found;
}

/** The phone number that starts at a group of a run, or null. */
function readPhone(groups, first, rest, labelled) {
  if (DATE_START_RE.test(rest)) return null;
  const head = groups[first].text;
  const international = /^\(?(?:\+|00)/.test(head);
  const trunk = /^\(0\)/.test(head) || /^\(?0/.test(head);
  const mobile = /^3\d{2}(?:\d{7})?$/.test(head);
  // A Swiss mobile without its trunk zero ("79 123 45 67"): only in that exact shape.
  const bare = /^7[5-9]$/.test(head) && groups.slice(first + 1, first + 4).map((group) => group.text.length).join() === '3,2,2'
    && groups.slice(first + 1, first + 4).every((group) => /^\d+$/.test(group.text));
  if (bare) {
    const end = groups[first + 3].end;
    return { phone: { index: groups[first].start, length: end - groups[first].start, key: digitsOnly(rest.slice(0, end - groups[first].start)) }, next: first + 4 };
  }
  if (!international && !trunk && !mobile && !labelled) return null;
  // A prefix written together with the number ("+41791234567"): its country is not told apart.
  const together = international && digitsOnly(head).replace(/^00/, '').length > 3;
  const country = international && !together ? digitsOnly(head).replace(/^00/, '') : '';
  let national = international && !together ? '' : digitsOnly(head).replace(/^00/, '');
  const sizes = international ? [] : [national.length];
  let last = first;
  for (let position = first + 1; position < groups.length; position += 1) {
    const digits = digitsOnly(groups[position].text.replace(/^\(0\)/, ''));
    const swissWhole = (international ? country === '41' && national.length === 9 : /^0\d{2}$/.test(digitsOnly(head)) && sizes.join() === '3,3,2,2');
    if (swissWhole) break;
    if (mobile && national.length === 10) break;
    if (national.length + digits.length > 12) break;
    // A whole number of ten digits is not followed by a group of one or two: that is the next figure
    // ("Tél. 06 12 34 56 78 15 ans", "Tel. 030 1234567 80%").
    if (national.length >= 10 && digits.length <= 2) break;
    if (national.length >= 7 && YEAR_GROUP_RE.test(digits)) break;
    national += digits;
    sizes.push(digits.length);
    last = position;
  }
  const long = mobile ? national.length === 10 : national.length >= (international || (labelled && !trunk) ? 7 : 9);
  if (!long) return null;
  const start = groups[first].start;
  const end = groups[last].end;
  if (DATE_IN_RE.test(rest.slice(0, end - start))) return null;
  return { phone: { index: start, length: end - start, key: `${country}${national}`.slice(-9) }, next: last + 1 };
}

/**
 * A text without its contact data. The digits of a phone number, an e-mail
 * address or a link are not a figure of the candidate: "un team di 45 persone"
 * was backed by a phone number that holds 45. Dates and years stay: each line
 * is read alone (a number never runs into the years of the next line), and a
 * line break takes the place of what is taken out, so the numbers on either
 * side stay two numbers.
 * @returns {{text: string, phones: Set<string>, links: Set<string>}} phones: the numbers taken out, by
 *   their last nine digits (a text may quote the candidate's own number, written as the CV writes it);
 *   links: every link taken out, as normalizeUrl writes it (a text may quote bare the link the CV writes
 *   with its scheme)
 */
function withoutContactData(text) {
  const phones = new Set();
  const links = new Set();
  const link = (match) => { links.add(normalizeUrl(match)); return '\n'; };
  const lines = String(text || '').split('\n').map((source) => {
    const line = source.replace(EMAIL_RE, '\n').replace(URL_RE, link).replace(BARE_URL_RE, link);
    return phoneNumbers(line).reverse().reduce((rest, phone) => {
      phones.add(phone.key);
      return `${rest.slice(0, phone.index)}\n${rest.slice(phone.index + phone.length)}`;
    }, line);
  });
  return { text: lines.join('\n'), phones, links };
}

/**
 * Index of what the sources say, normalized once.
 * @param {string[]} sources raw texts (CV text, profile JSON, posting, order data)
 * @param {{claimSources?: string[], numberSources?: string[], echoSources?: string[], entitySources?: string[]}} [options]
 *   claimSources: the texts that back a tool (the candidate's own); without them tools are not checked.
 *   numberSources: the texts a number of a claim field may come from (the candidate's own and the
 *     order line), their contact data aside; without them any source backs a number, as before.
 *   echoSources: the posting, for the advisory on capitalised words echoed from it.
 *   entitySources: the texts that may name an employer (candidate, order, posting); default: all sources.
 *   nameSources: names the text may quote whole, one per line (the company, the job title, the place):
 *     inside such a name a tool is not a claim ("Kubernetes Engineer" in "come Kubernetes Engineer"),
 *     but a name never backs a claim made outside it ("uso Kubernetes" stays the candidate's claim).
 *   quotedNameSources: names the text may quote whole and nothing more, one per line: their words back
 *     no job title (an apprenticeship's subject, «Candidatura per un posto di tirocinio come …»: its
 *     «tirocinio» is not a title the candidate held).
 */
export function buildFactIndex(sources, { claimSources, numberSources, echoSources, entitySources, nameSources, quotedNameSources } = {}) {
  const text = join(sources);
  const emails = new Set([...text.matchAll(EMAIL_RE)].map((match) => match[0].toLowerCase()));
  const urls = new Set([...text.matchAll(URL_RE)].map((match) => normalizeUrl(match[0])));
  // A phone of the sources, never the digits inside an e-mail address or a link, with or without its scheme
  // ("maria+41791234567@…", "linkedin.com/in/+41791234567").
  const phones = new Set([...text.replace(EMAIL_RE, ' ').replace(URL_RE, ' ').replace(BARE_URL_RE, ' ').matchAll(PHONE_RE)]
    .map((match) => digitsOnly(match[0]).slice(-9)));
  const claimRaw = claimSources ? join(claimSources) : null;
  const contacts = numberSources ? withoutContactData(join(numberSources)) : null;
  return {
    numbers: numbersOf(text),
    emails,
    urls,
    phones,
    lowerText: text.toLowerCase(),
    claimText: claimRaw === null ? null : foldText(claimRaw),
    claimRaw,
    claimWords: claimRaw === null ? null : wordsOf(`${claimRaw}\n${join(nameSources)}`),
    names: [...join(nameSources).split('\n'), ...join(quotedNameSources).split('\n')].map((line) => line.trim()).filter((line) => line.length >= 3),
    namesText: foldText(join(nameSources)),
    claimNumbers: contacts ? numbersOf(contacts.text) : null,
    // The candidate's own phone numbers that PHONE_RE does not read ("079 123 45 67"), and links.
    contactPhones: contacts ? contacts.phones : null,
    contactLinks: contacts ? contacts.links : null,
    echoWords: echoSources ? wordsOf(join(echoSources)) : null,
    entityText: ` ${foldText(join(entitySources || sources)).replace(/[^\p{L}\p{N}]+/gu, ' ')} `,
  };
}

// A number the posting gives may appear in the candidate's text only to quote
// the requirement the candidate does not meet ("pur non avendo i 5 anni
// richiesti"), never as the candidate's own figure. Both cues, a word of not
// having it and a word of the requirement, must be in the number's own clause:
// "Ho 5 anni di esperienza; sono gli anni richiesti" is a claim.
const NEGATION_CUE = /(pur non avend|non ho\b|non possied|non ancora|ancora non|non ho ancora|senza (?:i|gli|le)\b|ohne\b|noch nicht|noch keine|habe keine|fehlen|n'ai pas|n’ai pas|n'aie pas|n’aie pas|pas encore|sans les\b|do not have|don't have|don’t have|not yet|lack)/i;
const REQUIREMENT_CUE = /(richiest|requisit|richied|verlangt|gefordert|vorausgesetzt|gewünscht|requis|exigé|demandé|required|requires|requested|asked)/i;

/** The clause of a text around a position: between the nearest . ! ? ; : , or line break. */
function clauseAround(text, index) {
  const marks = /[.!?;:,\n]/g;
  let start = 0;
  let end = text.length;
  for (const match of text.matchAll(marks)) {
    if (match.index < index) start = match.index + 1;
    else { end = match.index; break; }
  }
  return text.slice(start, end);
}

const quotesRequirement = (text, index) => {
  const clause = clauseAround(text, index);
  return NEGATION_CUE.test(clause) && REQUIREMENT_CUE.test(clause);
};

/** Every run of a token is a word of the posting ("LQA", "ISO 9001"). */
const postingNames = (echoWords, token) => {
  const runs = foldText(token).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return Boolean(echoWords) && runs.length > 0 && runs.every((run) => echoWords.has(run));
};

// Legal forms that close an employer's name ("Esempio Software Srl", "Alpina Systems AG").
const LEGAL_FORM = String.raw`(?:AG|SA|GmbH|Sagl|SAGL|Srl|SRL|S\.r\.l\.|SpA|S\.p\.A\.|Sàrl|SARL|SNC|Snc|KG|Ltd|Inc|LLC)`;
const CAPITALISED = String.raw`\p{Lu}[\p{L}\p{N}&'’.-]*`;
const EMPLOYER_RE = new RegExp(String.raw`(?:${CAPITALISED}\s+){1,5}${LEGAL_FORM}(?![\p{L}\p{N}])`, 'gu');
// The words that introduce an employer (it/fr/en) or a job title (it/fr/en, and "als" in German).
const AT_EMPLOYER_RE = new RegExp(String.raw`(?<![\p{L}])(?:presso|chez|auprès de|at)\s+(${CAPITALISED}(?:\s+(?:${CAPITALISED}|di|de|du|des|of|&))*)`, 'gu');
const AS_TITLE_RE = new RegExp(String.raw`(?<![\p{L}])(come|in qualità di|en tant que|comme|as|als)\s+(${CAPITALISED}(?:\s+(?:${CAPITALISED}|of|di|de|du|des|der|für))*)`, 'gu');
// Capitalised words that are grammar or courtesy, never a claim (formal pronouns, articles, salutations).
const NOT_AN_ENTITY = new Set(`
lei la le loro sie ihnen ihr ihre ihrem ihren ihrer vous votre vos madame monsieur signora signor signore signori frau herr
you your the der die das den dem des ein eine einem einen einer il lo gli un una uno du de des les une
erstes erster letztes letzter
`.split(/\s+/).filter(Boolean));

const fold = (text) => ` ${foldText(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
// "Head of Engineering." → "Head of Engineering": the sentence's punctuation is not part of the name.
const tidy = (span) => span.trim().replace(/[.,;:!?’'-]+$/u, '');
// "In Initech Systems SA" → "Initech Systems SA": a capitalised preposition or article opening the sentence.
const LEADING = /^(?:(?:In|Bei|Bij|Chez|At|Da|Presso|Nella|Nel|Alla|Al|Der|Die|Das|Den|La|Le|Il|Lo|The)\s+)+/u;
const employerName = (span) => tidy(span).replace(LEADING, '');
const significant = (span) => foldText(span).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3 && !NOT_AN_ENTITY.has(word));

// "at Svag. Previously, I was…": a word closed by a full stop ends the sentence, and the name with
// it. Not an abbreviation ("St. Moritz", "Dott. Rossi", "S.p.A."): short, known, or with inner dots.
const ABBREVIATIONS = new Set(['dott', 'prof', 'corp', 'dipl', 'univ', 'hosp', 'mons', 'gebr', 'bros']);
const endsSentence = (word) => /^\p{Lu}[\p{L}\p{N}&'’-]{3,}\.$/u.test(word) && !ABBREVIATIONS.has(foldText(word.slice(0, -1)));
/** The part of a name before the sentence ends ("Svag. Previously" → "Svag."). */
function untilSentenceEnd(span) {
  const words = String(span).trim().split(/\s+/);
  const end = words.findIndex((word, position) => position < words.length - 1 && endsSentence(word));
  return end === -1 ? String(span) : words.slice(0, end + 1).join(' ');
}
/** The part of a name after the last sentence end before it ("Rossi. Alpina Systems AG" → "Alpina Systems AG"). */
function afterSentenceEnd(span) {
  const words = String(span).trim().split(/\s+/);
  let start = 0;
  for (let position = 0; position < words.length - 1; position += 1) if (endsSentence(words[position])) start = position + 1;
  return words.slice(start).join(' ');
}

// A language is named in the letter's language: "English" is the CV's "inglese", «madrelingua italiana»,
// «langue française» (accents folded). The forms a CV writes, never a stem: the stem of "Chinese" is in
// "machine learning" (review of #11020).
const LANGUAGE_NAMES = [
  ['english', 'inglese', 'englisch', 'anglais', 'anglaise'], ['german', 'tedesco', 'tedesca', 'deutsch', 'allemand', 'allemande'],
  ['french', 'francese', 'franzosisch', 'francais', 'francaise'], ['italian', 'italiano', 'italiana', 'italienisch', 'italien', 'italienne'],
  ['spanish', 'spagnolo', 'spagnola', 'spanisch', 'espagnol', 'espagnole'], ['portuguese', 'portoghese', 'portugiesisch', 'portugais', 'portugaise'],
  ['russian', 'russo', 'russa', 'russisch', 'russe'], ['arabic', 'arabo', 'araba', 'arabisch', 'arabe'], ['chinese', 'cinese', 'chinesisch', 'chinois', 'chinoise'],
  ['dutch', 'olandese', 'niederlandisch', 'neerlandais', 'neerlandaise'], ['romanian', 'rumeno', 'rumena', 'romeno', 'romena', 'rumanisch', 'roumain', 'roumaine'],
  ['albanian', 'albanese', 'albanisch', 'albanais', 'albanaise'], ['serbian', 'serbo', 'serba', 'serbisch', 'serbe'], ['croatian', 'croato', 'croata', 'kroatisch', 'croate'],
  ['turkish', 'turco', 'turca', 'turkisch', 'turc', 'turque'], ['polish', 'polacco', 'polacca', 'polnisch', 'polonais', 'polonaise'],
  ['ukrainian', 'ucraino', 'ukrainisch', 'ukrainien', 'ukrainienne'],
];
/**
 * A title's word is in the candidate's texts or the order line by a five-letter stem ("Leiter" is in
 * "Teamleiter"). A language's name only as a whole word, in any of the four languages.
 */
function titleWordBacked(word, index) {
  const names = LANGUAGE_NAMES.find((group) => group.includes(word));
  if (names) return new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.join('|')})(?![\\p{L}\\p{N}])`, 'u').test(`${index.claimText} ${index.namesText || ''}`);
  return index.claimText.includes(word.slice(0, 5)) || (index.namesText || '').includes(word.slice(0, 5));
}
// "as well as English", "such as Excel": the "as" of a comparison, never "as <job title>".
const COMPARISON_BEFORE_AS = /(?:\bas\s+well|\bsuch|\bas\s+soon|\bas\s+much|\bas\s+long|\bsame|\bcosì)\s+$/i;

/** An employer's name is backed when its last words before the legal form appear in a source. */
function employerBacked(span, entityText) {
  const words = span.trim().split(/\s+/);
  for (let start = 0; start < words.length - 1; start += 1) {
    if (entityText.includes(fold(words.slice(start).join(' ')))) return true;
  }
  return false;
}

/**
 * @param {Record<string,string>} texts generated texts by field name
 * @param {ReturnType<typeof buildFactIndex>} index
 * @param {{toolFields?: string[]}} [options] the fields where a tool, a figure of the candidate, an
 *   employer or a job title is a claim (default: all)
 * @returns {{ok:boolean, unsupported:Array<{field:string, kind:string, token:string, context:string}>, advisories:Array<{field:string, kind:string, token:string, context:string}>}}
 */
export function checkGeneratedFacts(texts, index, { toolFields } = {}) {
  const unsupported = [];
  const advisories = [];
  const seen = new Set();
  const report = (list) => (field, kind, token, context) => {
    const key = `${field}|${kind}|${token}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ field, kind, token, context });
  };
  const flag = report(unsupported);
  const advise = report(advisories);
  const inSet = (set, digits, parts) => set.has(digits) || (parts.length > 1 && parts.every((part) => set.has(part)));

  for (const [field, raw] of Object.entries(texts || {})) {
    const text = visible(raw);
    if (!text) continue;
    const claimField = !toolFields || toolFields.includes(field);
    const masked = [];
    for (const match of text.matchAll(EMAIL_RE)) {
      masked.push([match.index, match[0].length]);
      if (!index.emails.has(match[0].toLowerCase())) {
        flag(field, 'email', match[0], contextAround(text, match.index, match[0].length));
      }
    }
    for (const match of text.matchAll(URL_RE)) {
      masked.push([match.index, match[0].length]);
      const normalized = normalizeUrl(match[0]);
      const known = [...index.urls].some((url) => url === normalized || url.startsWith(normalized) || normalized.startsWith(url));
      if (!known && !index.lowerText.includes(normalized)) {
        flag(field, 'url', match[0], contextAround(text, match.index, match[0].length));
      }
    }
    for (const match of text.matchAll(PHONE_RE)) {
      masked.push([match.index, match[0].length]);
      // The candidate's own number, written as the CV writes it or with the prefix ("079 …" and "+41 79 …").
      const key = digitsOnly(match[0]).slice(-9);
      if (!index.phones.has(key) && !index.contactPhones?.has(key)) {
        flag(field, 'phone', match[0].trim(), contextAround(text, match.index, match[0].length));
      }
    }
    // The posting's reference ("réf. INF-2026-17") is quoted, never a claim: neither its digits nor its letters.
    const references = [...text.matchAll(REFERENCE_RE)].map((match) => [match.index, match[0].length]);
    const within = (spans, position) => spans.some(([start, length]) => position >= start && position < start + length);
    const isMasked = (position) => within(masked, position) || within(references, position);
    const checksClaims = typeof index.claimText === 'string' && claimField;
    // The company, the job title and the place quoted whole are names, not claims.
    const nameSpans = (index.names || []).flatMap((name) => [...text.matchAll(nameRegExp(name))]
      .map((match) => [match.index, match[0].length]));
    const claims = checksClaims ? claimTokens(text).filter((claim) => !within(nameSpans, claim.index)) : [];
    // The digits of a tool's name ("ISO 13485", "Office 365") are judged with the tool, not as a figure.
    const toolSpans = claims.map((claim) => [claim.index, claim.length]);
    // Nor are those of the candidate's own phone number or link, written as the sources write them
    // (the signature of the e-mail): they back no figure there, and are none here. Struck out, so a
    // figure next to them is still read alone.
    const figures = [
      ...lineStarts(text).flatMap(([line, offset]) => phoneNumbers(line).filter((phone) => index.contactPhones?.has(phone.key))
        .map((phone) => ({ index: offset + phone.index, length: phone.length }))),
      ...[...text.matchAll(BARE_URL_RE)].filter((match) => index.contactLinks?.has(normalizeUrl(match[0])))
        .map((match) => ({ index: match.index, length: match[0].length })),
    ].reduce((plain, { index: at, length }) => `${plain.slice(0, at)}${'#'.repeat(length)}${plain.slice(at + length)}`, text);
    for (const match of figures.matchAll(NUMBER_RE)) {
      if (isMasked(match.index) || within(toolSpans, match.index)) continue;
      const token = match[0].trim().replace(/[.,]$/, '');
      const digits = digitsOnly(token);
      if (!digits) continue;
      const parts = token.split(/[^\d]+/).filter(Boolean);
      const supported = index.claimNumbers && claimField
        ? inSet(index.claimNumbers, digits, parts) || (inSet(index.numbers, digits, parts) && quotesRequirement(text, match.index))
        : inSet(index.numbers, digits, parts);
      if (!supported) flag(field, 'number', token, contextAround(text, match.index, match[0].length));
    }
    if (!checksClaims) continue;
    const claimSide = { folded: index.claimText, raw: index.claimRaw };
    const quotesGap = gapReader(text, claims);
    for (const claim of claims) {
      if (isMasked(claim.index) || backsClaim(claimSide, claim)) continue;
      // Named by the posting and quoted as still to learn (or not had): the gap said honestly, no
      // claim. Reported all the same, so the owner sees what was let through.
      if (postingNames(index.echoWords, claim.token) && quotesGap(claim)) {
        advise(field, 'gap', claim.token, contextAround(text, claim.index, claim.length));
        continue;
      }
      flag(field, 'tool', claim.token, contextAround(text, claim.index, claim.length));
    }
    // Employers: a name closed by a legal form, or introduced by presso/chez/at.
    for (const match of text.matchAll(EMPLOYER_RE)) {
      const name = afterSentenceEnd(match[0]);
      if (!employerBacked(name, index.entityText)) flag(field, 'employer', employerName(name), contextAround(text, match.index, match[0].length));
    }
    for (const match of text.matchAll(AT_EMPLOYER_RE)) {
      const name = untilSentenceEnd(match[1]);
      if (significant(name).some((word) => !index.entityText.includes(` ${word} `))) {
        flag(field, 'employer', tidy(name), contextAround(text, match.index, match[0].length));
      }
    }
    // Job titles: every significant word of "come/en tant que/as <Title>" in the candidate's texts or the
    // order line, by a five-letter stem. German capitalises every noun, so after "als" it is an advisory.
    for (const match of text.matchAll(AS_TITLE_RE)) {
      if (COMPARISON_BEFORE_AS.test(text.slice(Math.max(0, match.index - 12), match.index))) continue;
      const title = untilSentenceEnd(match[2]);
      // The posting's own title is a name the candidate applies as ("mi candido come Product Manager").
      const missing = significant(title).filter((word) => word.length >= 4 && !titleWordBacked(word, index));
      if (!missing.length) continue;
      (match[1].toLowerCase() === 'als' ? advise : flag)(field, 'title', tidy(title), contextAround(text, match.index, match[0].length));
    }
    // Advisory: a capitalised word the text echoes from the posting and no source of the candidate names.
    if (index.echoWords) {
      for (const match of text.matchAll(/(?<![\p{L}\p{N}])\p{Lu}[\p{L}'’-]{2,}/gu)) {
        const word = foldText(match[0]).replace(/['’-].*$/, '');
        if (word.length < 3 || NOT_AN_ENTITY.has(word) || !index.echoWords.has(word) || index.claimWords.has(word) || isMasked(match.index)) continue;
        advise(field, 'posting_echo', match[0], contextAround(text, match.index, match[0].length));
      }
    }
  }
  return { ok: unsupported.length === 0, unsupported, advisories };
}
