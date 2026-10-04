/**
 * L6 automated source check: the figures an article states in its key-facts
 * list, compared deterministically with the external source the article
 * cites, and with each translation. Pure functions, no network, no model.
 *
 * What it attests, and what it does not: a row says "these N figures from
 * `## Fatti chiave` / `## In breve` appear (or do not appear) in the text of
 * the cited source and in the translated body". It never judges the
 * interpretation, the prose, or figures outside those two lists. A
 * `confirmed_defect` is a lead to verify, not a proven error.
 *
 * Row format: the `automated-source-check` contract of
 * `scripts/ci/export-l6-factuality-outcomes.mjs` (owner decision of
 * 2026-09-24 in DECISIONS.md, "Loop L1-L11 automatici ... fonti citate per
 * L6"). The source-URL independence rule is imported from that exporter so
 * the producer cannot drift from the contract that validates its rows.
 *
 * Number normalisation:
 * - thousands separators `.`, `'`, `’`, spaces (regular, no-break, thin) are
 *   removed; the decimal comma becomes a point;
 * - multipliers: `mila` = 1e3, `milioni`/`mio`/`Mio.`/`mln` = 1e6,
 *   `miliardi`/`mld`/`Mrd.` = 1e9 (plus their en/de/fr equivalents, which the
 *   translations and the sources use);
 * - percentages are compared as plain numbers (`10%` -> 10);
 * - in the article's key facts, one-digit numbers and four-digit years
 *   (1900-2100) are discarded, as are calendar dates, clock times and legal
 *   references (`art. 15`); a bare number equal to the mantissa of a
 *   multiplied figure ("21,16" next to "21,16 milioni") is the same figure;
 * - on the source side, Italian number words ("settanta") count as numbers.
 * The article side reads numbers strictly (Italian convention). The source
 * and translation side keeps every plausible reading of an ambiguous token
 * (`1,500` is both 1.5 and 1500): a lenient match can only turn a doubtful
 * case into "found", never into a false defect.
 */
import { independentSourceUrlIssue } from '../ci/export-l6-factuality-outcomes.mjs';

export const AUTOMATED_REVIEWER_TYPE = 'automated-source-check';
export const AUTOMATED_METHOD = 'figures-in-source+locale-numeric-parity';
export const L6_LOCALES = ['it', 'en', 'de', 'fr'];
export const EVIDENCE_SCOPE = 'figures listed under "Fatti chiave"/"In breve" only; not the interpretation or the prose';

const KEY_FACT_HEADINGS = /^#{2,3}\s*(?:fatti chiave|in breve)\s*$/i;
const CITATION_RE = /\*\s*Fonte\s*:\s*\[([^\]]+)\]\(\s*([^)\s]+)\s*\)\s*\*/gi;

const SPACE_CLASS = '[\\s\\u00a0\\u202f\\u2009]';
// Multiplier words that may follow a number. Italian is what the articles
// use; the en/de/fr forms appear in translations and in external sources.
const MULTIPLIERS = [
  [/^(?:mila|thousand|tausend|tsd\.?|mille)$/i, 1e3],
  [/^(?:milion[ei]|mln|mio\.?|million(?:s|e|en)?|mn)$/i, 1e6],
  [/^(?:miliard[oi]|mld\.?|mrd\.?|milliard(?:s|e|en)?|billion(?:s)?|bn)$/i, 1e9],
];
const MULTIPLIER_WORD = '(?:mila|thousand|tausend|tsd\\.?|mille|milion[ei]|mln|mio\\.?|million(?:s|e|en)?|mn|miliard[oi]|mld\\.?|mrd\\.?|milliard(?:s|e|en)?|billion(?:s)?|bn)(?![\\p{L}\\d])';
// A number token: grouped (1'200'000, 1.200.000, 1 200 000, 1,500) or plain
// (2026, 3,5, 2.75), never starting inside another number, a time or a date.
// An apostrophe right before a digit is an elision ("l’1,2%", "all’80%"),
// not a thousands separator, unless a digit precedes it. The strict (article)
// reading also refuses a number glued to a word; the lenient one accepts it,
// so "U23" in a translation matches "Under 23".
const numberToken = (notAfter) => new RegExp(
  `(?<![${notAfter}])(?<!\\d['’])(\\d{1,3}(?:(?:[.,'’\\u00a0\\u202f\\u2009]| (?=\\d{3}(?!\\d)))\\d{3})+(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?)(?![\\d]|[:/]\\d)(?:${SPACE_CLASS}*(${MULTIPLIER_WORD}))?`,
  'giu',
);
const NUMBER_TOKEN_STRICT = numberToken('\\d.,:/\\p{L}');
const NUMBER_TOKEN_LENIENT = numberToken('\\d.,:/');
const MONTHS = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'januar', 'februar', 'märz', 'mai', 'juni', 'juli', 'oktober', 'dezember',
  'janvier', 'février', 'mars', 'avril', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
].join('|');
const DATE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g,
  /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g,
  new RegExp(`\\b\\d{1,2}(?:°|º|\\.|er)?${SPACE_CLASS}+(?:${MONTHS})\\b`, 'giu'),
  new RegExp(`\\b(?:${MONTHS})${SPACE_CLASS}+\\d{1,2}(?:st|nd|rd|th)?\\b(?!${SPACE_CLASS}*\\d{3})`, 'giu'),
  // Clock times: Italian writes them with a dot ("poco dopo le 2.30").
  /\b(?:ore|alle|dalle|le|verso)\s+\d{1,2}[.:][0-5]\d\b/giu,
  /\b\d{1,2}[.:][0-5]\d\s*(?:h|uhr|am|pm|a\.m\.|p\.m\.)(?![\p{L}])/giu,
];
const LEGAL_REFERENCE = /\b(?:art(?:icol[oi]|t)?|cpv|lett|n|nr)\.?\s*\d+[a-z]?\b/giu;

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function stripMarkdown(text) {
  return String(text ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_`]+/g, '');
}

function stripNonFigures(text) {
  let out = String(text ?? '');
  for (const pattern of DATE_PATTERNS) out = out.replace(pattern, ' ');
  return out.replace(LEGAL_REFERENCE, ' ');
}

function multiplierValue(word) {
  if (!word) return 1;
  for (const [pattern, value] of MULTIPLIERS) if (pattern.test(word)) return value;
  return 1;
}

/** Stable comparison key of a normalised value (floating noise removed). */
export function figureKey(value) {
  return String(Number(Number(value).toPrecision(12)));
}

/**
 * Every plausible numeric reading of a token. `strict` applies the Italian
 * convention the articles use and returns exactly one reading.
 */
function readingsOfToken(token, { strict }) {
  const compact = token.replace(/['’\u00a0\u202f\u2009 ]/g, '');
  const hasDot = compact.includes('.');
  const hasComma = compact.includes(',');
  const asNumber = (s) => Number(s);
  if (hasDot && hasComma) {
    // Both present: the last one is the decimal mark, the other groups.
    return compact.lastIndexOf(',') > compact.lastIndexOf('.')
      ? [asNumber(compact.replace(/\./g, '').replace(',', '.'))]
      : [asNumber(compact.replace(/,/g, ''))];
  }
  const separator = hasDot ? '.' : (hasComma ? ',' : null);
  if (!separator) return [asNumber(compact)];
  const parts = compact.split(separator);
  const grouped = parts.length > 2 || (parts.length === 2 && parts[1].length === 3);
  const asGrouped = asNumber(parts.join(''));
  const asDecimal = parts.length === 2 ? asNumber(`${parts[0]}.${parts[1]}`) : NaN;
  if (strict) {
    // Italian: the comma is always decimal; the dot groups thousands only
    // when it is followed by exactly three digits (or repeats).
    if (separator === ',') return [asDecimal];
    return [grouped ? asGrouped : asDecimal];
  }
  if (parts.length > 2) return [asGrouped];
  return parts[1].length === 3 ? [asGrouped, asDecimal] : [asDecimal];
}

function scanNumbers(text, { strict }) {
  // Dates, clock times and legal references are dropped only from the
  // article's figures: on the lenient side every number stays a candidate.
  const prepared = strict ? stripNonFigures(stripMarkdown(text)) : stripMarkdown(text);
  const found = [];
  for (const match of prepared.matchAll(strict ? NUMBER_TOKEN_STRICT : NUMBER_TOKEN_LENIENT)) {
    const token = match[1];
    const word = match[2] || '';
    const multiplier = multiplierValue(word);
    const values = readingsOfToken(token, { strict }).filter((value) => Number.isFinite(value));
    if (!values.length) continue;
    found.push({
      raw: `${token}${word ? ` ${word}` : ''}`.trim(),
      token,
      multiplier,
      values: values.map((value) => value * multiplier),
    });
  }
  return found;
}

// Italian number words (sources write "oltre settanta docenti" where the
// article writes "Oltre 70 docenti"): 10-999 and their "-mila" thousands.
// Only the lenient side reads them, so they can turn a doubtful figure into
// "found", never into a defect.
const ITALIAN_NUMBER_WORDS = (() => {
  const units = ['', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove'];
  const teens = ['dieci', 'undici', 'dodici', 'tredici', 'quattordici', 'quindici', 'sedici', 'diciassette', 'diciotto', 'diciannove'];
  const tens = ['', '', 'venti', 'trenta', 'quaranta', 'cinquanta', 'sessanta', 'settanta', 'ottanta', 'novanta'];
  const below100 = (n) => {
    if (n < 10) return units[n];
    if (n < 20) return teens[n - 10];
    const ten = tens[Math.floor(n / 10)];
    const unit = n % 10;
    if (unit === 0) return ten;
    const stem = unit === 1 || unit === 8 ? ten.slice(0, -1) : ten;
    return `${stem}${unit === 3 ? 'tré' : units[unit]}`;
  };
  const words = new Map();
  for (let n = 10; n < 1000; n += 1) {
    const hundreds = Math.floor(n / 100);
    const rest = n % 100;
    const head = hundreds === 0 ? '' : `${hundreds === 1 ? '' : units[hundreds]}cento`;
    const tail = below100(rest);
    const word = hundreds && /^o/.test(tail) ? `${head.slice(0, -1)}${tail}` : `${head}${tail}`;
    words.set(word, n);
    if (word.endsWith('tré')) words.set(`${word.slice(0, -1)}e`, n);
  }
  for (const [word, value] of [...words]) words.set(`${word.endsWith('tré') ? `${word.slice(0, -1)}e` : word}mila`, value * 1000);
  for (let n = 2; n < 10; n += 1) words.set(`${units[n]}mila`, n * 1000);
  words.set('cento', 100);
  words.set('mille', 1000);
  return words;
})();
const WORD_WITH_MULTIPLIER = new RegExp(`(\\p{L}+)(?:${SPACE_CLASS}+(${MULTIPLIER_WORD}))?`, 'gu');

/** Comparison keys of every number in a text, with every plausible reading. */
export function numberKeysInText(text) {
  const keys = new Set();
  for (const item of scanNumbers(text, { strict: false })) {
    for (const value of item.values) keys.add(figureKey(value));
  }
  for (const match of String(text ?? '').toLowerCase().matchAll(WORD_WITH_MULTIPLIER)) {
    const value = ITALIAN_NUMBER_WORDS.get(match[1]);
    if (value !== undefined) keys.add(figureKey(value * multiplierValue(match[2])));
  }
  return keys;
}

/**
 * Text of an HTML page: scripts and styles removed (JSON-LD kept, since news
 * sites often put the article body there), tags dropped, entities decoded.
 */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b(?![^>]*application\/ld\+json)[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<(style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&(?:rsquo|lsquo|apos);/gi, '’')
    .replace(/&(?:quot|ldquo|rdquo|laquo|raquo);/gi, '"')
    .replace(/&ndash;|&mdash;/gi, '-')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();
}

function safeCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return ' ';
  }
}

/**
 * The source cited by the article: the LAST `*Fonte: [label](url)*`. Returns
 * null when absent, when the URL is not https, or when it is not an
 * independent third-party host (this site, its mirrors, an IP literal or
 * localhost: the same rule the exporter enforces).
 */
export function extractSourceCitation(bodyText) {
  const matches = [...String(bodyText ?? '').matchAll(CITATION_RE)];
  if (!matches.length) return null;
  const url = matches[matches.length - 1][2].trim();
  if (independentSourceUrlIssue(url)) return null;
  const parsed = new URL(url);
  return { host: parsed.hostname.toLowerCase(), url: parsed.href };
}

/** Bullet lines under `## Fatti chiave` and `## In breve`. */
function keyFactLines(bodyText) {
  const lines = String(bodyText ?? '').split(/\r?\n/);
  const out = [];
  let inside = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,6}\s/.test(trimmed)) {
      inside = KEY_FACT_HEADINGS.test(trimmed);
      continue;
    }
    if (!inside) continue;
    if (!trimmed) continue;
    if (/^[-*•]\s+/.test(trimmed)) {
      out.push(trimmed.replace(/^[-*•]\s+/, ''));
      continue;
    }
    // First prose paragraph after the list closes the section.
    inside = false;
  }
  return out;
}

/**
 * Figures stated in the article's key facts, Italian-normalised, one per
 * distinct value: `{ raw, value, key }`. One-digit numbers (without a
 * multiplier) and four-digit years 1900-2100 are discarded.
 */
export function extractKeyFigures(bodyText) {
  const items = keyFactLines(bodyText).flatMap((line) => scanNumbers(line, { strict: true }));
  // "1,66 milioni per il 2025 e 21,16 per il 2026": a bare number equal to
  // the mantissa of a multiplied figure is the same figure, written short.
  const mantissas = new Set(items
    .filter((item) => item.multiplier !== 1)
    .map((item) => figureKey(item.values[0] / item.multiplier)));
  const figures = [];
  const seen = new Set();
  for (const item of items) {
    const value = item.values[0];
    const digits = item.token.replace(/\D/g, '');
    if (item.multiplier === 1 && digits.length === 1) continue;
    if (item.multiplier === 1 && /^\d{4}$/.test(item.token) && value >= 1900 && value <= 2100) continue;
    if (item.multiplier === 1 && mantissas.has(figureKey(value))) continue;
    const key = figureKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    figures.push({ raw: item.raw, value, key });
  }
  return figures;
}

function keysOf(textOrKeys) {
  return textOrKeys instanceof Set ? textOrKeys : numberKeysInText(textOrKeys);
}

function figureKeyOf(figure) {
  return typeof figure === 'number' ? figureKey(figure) : figure.key ?? figureKey(figure.value);
}

/** True when the figure's normalised value appears among the source's numbers. */
export function figureInSource(figure, sourceText) {
  return keysOf(sourceText).has(figureKeyOf(figure));
}

/** Italian figures that do not appear in a translated body. */
export function missingLocaleFigures(itFigures, translatedBodyText) {
  const keys = keysOf(translatedBodyText);
  return itFigures.filter((figure) => !keys.has(figureKeyOf(figure)));
}

/** True when every Italian figure appears in the translated body. */
export function localeNumericParity(itFigures, translatedBodyText) {
  return missingLocaleFigures(itFigures, translatedBodyText).length === 0;
}

/**
 * Ledger rows for one article, one per locale whose body is present.
 *
 * `bodies`: `{ it, en, de, fr }` body texts (missing locale -> no row).
 * `source`: `{ url, finalUrl?, httpStatus, fetchedAt, sha256, text }` of the
 * download done in this run (text already extracted from HTML).
 *
 * No row at all when there is no Italian body, no figure, or no successful
 * download: none of those is a verdict. A figure counts as matched for
 * locale L only when it is in the source AND (for L != it) in L's body;
 * otherwise it is listed as `source:<figure>` or `locale:<figure>`.
 * `localeVerified` is always true on an emitted row (the locale body was read
 * and compared); a parity gap is expressed as a defect, never as false.
 */
export function buildVerdictRows({ articleId, bodies, source, now = () => new Date() }) {
  if (!isText(articleId) || !isText(bodies?.it)) return [];
  if (!source || source.httpStatus !== 200 || !isText(source.url) || !isText(source.sha256) || !isText(source.fetchedAt)) return [];
  const figures = extractKeyFigures(bodies.it);
  if (!figures.length) return [];
  const sourceKeys = numberKeysInText(source.text ?? '');
  const rows = [];
  for (const locale of L6_LOCALES) {
    const body = bodies[locale];
    if (!isText(body)) continue;
    const localeKeys = locale === 'it' ? null : numberKeysInText(body);
    const missing = [];
    let matched = 0;
    for (const figure of figures) {
      if (!sourceKeys.has(figure.key)) missing.push(`source:${figure.raw}`);
      else if (localeKeys && !localeKeys.has(figure.key)) missing.push(`locale:${figure.raw}`);
      else matched += 1;
    }
    const evidence = {
      method: AUTOMATED_METHOD,
      scope: EVIDENCE_SCOPE,
      sourceUrl: source.url,
      sourceRefs: [source.url],
      sourceHttpStatus: source.httpStatus,
      sourceFetchedAt: source.fetchedAt,
      sourceSha256: source.sha256,
      figuresChecked: figures.length,
      figuresMatched: matched,
      externalSourceVerified: true,
      localeVerified: true,
    };
    if (isText(source.finalUrl) && source.finalUrl !== source.url) evidence.sourceFinalUrl = source.finalUrl;
    if (missing.length) evidence.missingFigures = missing;
    rows.push({
      reviewedAt: now().toISOString(),
      articleId,
      locale,
      verdict: matched === figures.length ? 'supported' : 'confirmed_defect',
      reviewerType: AUTOMATED_REVIEWER_TYPE,
      observationRef: `L6.source-check.${articleId}.${locale}`,
      evidence,
    });
  }
  return rows;
}
