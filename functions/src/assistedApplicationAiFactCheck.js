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
 */

const NUMBER_RE = /\d(?:[\d'’.,  ]*\d)?/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()"']+/gi;
const PHONE_RE = /(?:\+|00)\d[\d\s/.-]{7,}\d/g;
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

/**
 * Index of what the sources say, normalized once.
 * @param {string[]} sources raw texts (CV text, profile JSON, posting, order data)
 * @param {{claimSources?: string[]}} [options] the texts that back a tool (the
 *   candidate's own); without them tools are not checked
 */
export function buildFactIndex(sources, { claimSources } = {}) {
  const text = sources.filter(Boolean).map(String).join('\n');
  const numbers = new Set();
  for (const match of text.matchAll(NUMBER_RE)) {
    const digits = digitsOnly(match[0]);
    if (digits) numbers.add(digits);
    // "2'500" and "2.500,50" also contribute their parts ("2", "500").
    for (const part of match[0].split(/[^\d]+/)) if (part) numbers.add(part);
  }
  const emails = new Set([...text.matchAll(EMAIL_RE)].map((match) => match[0].toLowerCase()));
  const urls = new Set([...text.matchAll(URL_RE)].map((match) => normalizeUrl(match[0])));
  const phones = new Set([...text.matchAll(PHONE_RE)].map((match) => digitsOnly(match[0]).slice(-9)));
  const claimText = claimSources ? foldText(claimSources.filter(Boolean).map(String).join('\n')) : null;
  return { numbers, emails, urls, phones, lowerText: text.toLowerCase(), claimText };
}

/**
 * @param {Record<string,string>} texts generated texts by field name
 * @param {ReturnType<typeof buildFactIndex>} index
 * @param {{toolFields?: string[]}} [options] the fields where a tool is a claim (default: all)
 * @returns {{ok:boolean, unsupported:Array<{field:string, kind:string, token:string, context:string}>}}
 */
export function checkGeneratedFacts(texts, index, { toolFields } = {}) {
  const unsupported = [];
  const seen = new Set();
  const flag = (field, kind, token, context) => {
    const key = `${field}|${kind}|${token}`;
    if (seen.has(key)) return;
    seen.add(key);
    unsupported.push({ field, kind, token, context });
  };

  for (const [field, raw] of Object.entries(texts || {})) {
    const text = String(raw || '');
    if (!text) continue;
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
      if (!index.phones.has(digitsOnly(match[0]).slice(-9))) {
        flag(field, 'phone', match[0].trim(), contextAround(text, match.index, match[0].length));
      }
    }
    const within = (spans, position) => spans.some(([start, length]) => position >= start && position < start + length);
    const isMasked = (position) => within(masked, position);
    for (const match of text.matchAll(NUMBER_RE)) {
      if (isMasked(match.index)) continue;
      const token = match[0].trim().replace(/[.,]$/, '');
      const digits = digitsOnly(token);
      if (!digits) continue;
      const parts = token.split(/[^\d]+/).filter(Boolean);
      const supported = index.numbers.has(digits) || (parts.length > 1 && parts.every((part) => index.numbers.has(part)));
      if (!supported) flag(field, 'number', token, contextAround(text, match.index, match[0].length));
    }
    if (typeof index.claimText !== 'string' || (toolFields && !toolFields.includes(field))) continue;
    const references = [...text.matchAll(REFERENCE_RE)].map((match) => [match.index, match[0].length]);
    for (const { token, index: at, length } of toolTokens(text)) {
      if (isMasked(at) || within(references, at) || mentionsTool(index.claimText, token)) continue;
      flag(field, 'tool', token, contextAround(text, at, length));
    }
  }
  return { ok: unsupported.length === 0, unsupported };
}
