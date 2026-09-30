/**
 * Deterministic fact gate for AI-written application texts.
 *
 * Idea taken from career-ops' verify-cv-facts (MIT): a generated document may
 * reformulate the candidate's CV but never introduce a fact the sources do
 * not contain. Language-agnostic by construction — it checks the tokens a
 * model most often invents or "rounds" (numbers, years, percentages, e-mail
 * addresses, URLs, phone numbers), not prose. A failing gate does not block
 * the draft: it lists each unsupported token so the operator fixes or
 * confirms it before anything reaches an employer.
 */

const NUMBER_RE = /\d(?:[\d'’.,  ]*\d)?/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()"']+/gi;
const PHONE_RE = /(?:\+|00)\d[\d\s/.-]{7,}\d/g;

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

/**
 * Index of what the sources say, normalized once.
 * @param {string[]} sources raw texts (CV text, profile JSON, posting, order data)
 */
export function buildFactIndex(sources) {
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
  return { numbers, emails, urls, phones, lowerText: text.toLowerCase() };
}

/**
 * @param {Record<string,string>} texts generated texts by field name
 * @param {ReturnType<typeof buildFactIndex>} index
 * @returns {{ok:boolean, unsupported:Array<{field:string, kind:string, token:string, context:string}>}}
 */
export function checkGeneratedFacts(texts, index) {
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
    const isMasked = (position) => masked.some(([start, length]) => position >= start && position < start + length);
    for (const match of text.matchAll(NUMBER_RE)) {
      if (isMasked(match.index)) continue;
      const token = match[0].trim().replace(/[.,]$/, '');
      const digits = digitsOnly(token);
      if (!digits) continue;
      const parts = token.split(/[^\d]+/).filter(Boolean);
      const supported = index.numbers.has(digits) || (parts.length > 1 && parts.every((part) => index.numbers.has(part)));
      if (!supported) flag(field, 'number', token, contextAround(text, match.index, match[0].length));
    }
  }
  return { ok: unsupported.length === 0, unsupported };
}
