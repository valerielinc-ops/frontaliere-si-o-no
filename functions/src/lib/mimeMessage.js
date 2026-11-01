/**
 * Minimal MIME reader for the inbound CV of the assisted application: the
 * candidate replies to valerie@ with the CV attached, the Cloudflare Email
 * Worker hands the raw message to assistedApplicationEmailCv.js.
 *
 * It reads what that flow needs and nothing more: top-level headers, the
 * leaf parts of (nested) multiparts, base64 / quoted-printable bodies,
 * attachment file names (RFC 2231 and RFC 2047), the first text/plain part (or
 * an HTML part converted to text),
 * safe links from HTML alternatives, and the sender-authentication verdict
 * Cloudflare writes in Authentication-Results. No dependency, so it deploys
 * with the functions.
 */

import { EMAIL_RE } from './emailValidation.js';

const MAX_PARTS = 40;
const MAX_DEPTH = 4;
const MAX_HTML_LINKS_TO_APPEND = 20;
const MAX_HTML_LINK_LENGTH = 2048;

function splitHeaderBody(raw) {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('latin1');
  const match = /\r?\n\r?\n/.exec(text);
  if (!match) return { headerText: text, body: '' };
  return { headerText: text.slice(0, match.index), body: text.slice(match.index + match[0].length) };
}

/** Unfolded headers, names lower-cased, repeated headers kept in order. */
export function parseHeaders(headerText) {
  const headers = [];
  for (const line of String(headerText || '').replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    headers.push([line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()]);
  }
  return headers;
}

const header = (headers, name) => headers.find(([key]) => key === name)?.[1] || '';

function parameter(value, name) {
  const text = String(value || '');
  // RFC 2231 (name*=utf-8''..., possibly split into name*0*=...)
  const continued = [...text.matchAll(new RegExp(`${name}\\*(\\d+)\\*?=\\s*("([^"]*)"|[^;]*)`, 'gi'))]
    .sort((left, right) => Number(left[1]) - Number(right[1]))
    .map((match) => (match[3] ?? match[2]).trim());
  if (continued.length) return decodeRfc2231(continued.join(''));
  const extended = new RegExp(`${name}\\*=\\s*([^;]+)`, 'i').exec(text);
  if (extended) return decodeRfc2231(extended[1].trim());
  const plain = new RegExp(`${name}=\\s*("([^"]*)"|[^;]*)`, 'i').exec(text);
  return plain ? decodeEncodedWords((plain[2] ?? plain[1]).trim()) : '';
}

function decodeRfc2231(value) {
  const match = /^([^']*)'[^']*'(.*)$/.exec(value);
  const encoded = match ? match[2] : value;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

const ENCODED_WORD_PATTERN = /=\?([^\s?]+)\?([bqBQ])\?([\x21-\x3e\x40-\x7e]+)\?=/g;
const ENCODED_WORD_MAX_LENGTH = 75;
const HEADER_CONTROL = /[\u0000-\u001f\u007f]/;
const RFC2047_CHARSET_TOKEN = /^[\x21-\x7e]+$/;
const RFC2047_CHARSET_SPECIALS = '()<>@,;:\"/?.=';
const RFC2231_LANGUAGE_TAG = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;

function encodedWordCharsetName(charset) {
  const languageSeparator = charset.indexOf('*');
  const charsetName = languageSeparator === -1 ? charset : charset.slice(0, languageSeparator);
  const language = languageSeparator === -1 ? '' : charset.slice(languageSeparator + 1);
  if (!RFC2047_CHARSET_TOKEN.test(charsetName)
    || [...charsetName].some((character) => RFC2047_CHARSET_SPECIALS.includes(character))) return null;
  if (languageSeparator !== -1
    && (charset.indexOf('*', languageSeparator + 1) !== -1 || !RFC2231_LANGUAGE_TAG.test(language))) return null;
  return charsetName;
}

function decodeEncodedWord(charset, encoding, text) {
  try {
    const charsetName = encodedWordCharsetName(charset);
    if (!charsetName || text.length === 0) return null;
    let bytes;
    if (encoding.toLowerCase() === 'b') {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return null;
      bytes = Buffer.from(text, 'base64');
    } else {
      if (/=(?![0-9A-Fa-f]{2})/.test(text)) return null;
      bytes = Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))), 'latin1');
    }
    const normalizedCharset = /^utf-?8$/i.test(charsetName) ? 'utf-8' : charsetName;
    const decoded = new TextDecoder(normalizedCharset, { fatal: true }).decode(bytes);
    return HEADER_CONTROL.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

/** RFC 2047 encoded words (=?utf-8?B?...?= / =?utf-8?Q?...?=). */
export function decodeEncodedWords(value) {
  const input = String(value || '');
  let decoded = '';
  let cursor = 0;
  let previousWordDecoded = false;
  for (const match of input.matchAll(ENCODED_WORD_PATTERN)) {
    const start = match.index ?? 0;
    const separator = input.slice(cursor, start);
    const word = match[0].length <= ENCODED_WORD_MAX_LENGTH
      ? decodeEncodedWord(match[1], match[2], match[3])
      : null;
    if (!(previousWordDecoded && word !== null && /^[ \t\r\n]*$/.test(separator))) decoded += separator;
    decoded += word ?? match[0];
    previousWordDecoded = word !== null;
    cursor = start + match[0].length;
  }
  return decoded + input.slice(cursor);
}

function decodeBody(body, transferEncoding) {
  const encoding = String(transferEncoding || '').toLowerCase();
  if (encoding === 'base64') return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (encoding === 'quoted-printable') {
    const text = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    return Buffer.from(text, 'latin1');
  }
  return Buffer.from(body, 'latin1');
}

function removeNonContentHtml(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:script|style|head|title|svg|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|head|title|svg|noscript)>/gi, ' ');
}

function decodeHtmlEntity(entity) {
  const lower = String(entity || '').toLowerCase();
  if (lower === 'amp') return '&';
  if (lower === 'lt') return '<';
  if (lower === 'gt') return '>';
  if (lower === 'quot') return '"';
  if (lower === 'apos') return "'";
  if (lower === 'nbsp') return ' ';
  const codePoint = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
  return Number.isSafeInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : ' ';
}

function decodeHtmlEntities(value) {
  return String(value || '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => decodeHtmlEntity(entity));
}

/** Turn an HTML-only message into the text the classifier and the runner need. */
export function htmlToText(html, { safeLinksOnly = false } = {}) {
  return removeNonContentHtml(html)
    // Verification links are often the only copy of the token in a portal mail.
    .replace(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi, (_, doubleQuoted, singleQuoted, bare, label) => {
      const href = doubleQuoted || singleQuoted || bare;
      if (!safeLinksOnly) return `${label} ${href}`;
      const safeUrl = normalizedHttpsUrl(decodeHtmlEntities(href));
      return safeUrl ? `${label} ${safeUrl}` : label;
    })
    .replace(/<(?:br\s*\/?>|\/(?:p|div|li|tr|h[1-6]|td|th|section|article|table|ul|ol))\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => decodeHtmlEntity(entity))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizedHttpsUrl(value) {
  const candidate = String(value || '').trim();
  if (!candidate || candidate.length > MAX_HTML_LINK_LENGTH || /[\u0000-\u0020\u007f<>"']/.test(candidate)) return '';
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function extractHtmlLinks(html) {
  const content = removeNonContentHtml(html);
  const links = [];
  const seen = new Set();
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  const hrefPattern = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
  for (const match of content.matchAll(anchorPattern)) {
    const hrefMatch = hrefPattern.exec(match[1] || '');
    if (!hrefMatch) continue;
    const url = normalizedHttpsUrl(decodeHtmlEntities(hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? ''));
    if (!url || seen.has(url)) continue;
    const label = htmlToText(match[2]).replace(/\s+/g, ' ').trim().slice(0, 180);
    links.push({ url, label });
    seen.add(url);
    if (links.length >= MAX_HTML_LINKS_TO_APPEND) break;
  }
  return links;
}

function urlTokensInText(text) {
  const tokens = [];
  const seen = new Set();
  for (const match of String(text || '').matchAll(/https:\/\/[^\s<>"'`]+/gi)) {
    let token = match[0];
    while (/[.,;!?]$/.test(token)) token = token.slice(0, -1);
    while (token.endsWith(')') && (token.match(/\(/g) || []).length < (token.match(/\)/g) || []).length) token = token.slice(0, -1);
    const url = normalizedHttpsUrl(token);
    if (url && !seen.has(url)) {
      tokens.push(url);
      seen.add(url);
    }
  }
  return tokens;
}

function appendHtmlOnlyLinks(plainText, html) {
  const original = String(plainText || '');
  const present = new Set(urlTokensInText(original));
  const missing = extractHtmlLinks(html).filter(({ url }) => !present.has(url));
  if (!missing.length) return original;
  const lines = missing.map(({ label, url }) => label && label !== url ? `${label}: ${url}` : url);
  return `${original.trimEnd()}${original.trim() ? '\n\n' : ''}${lines.join('\n')}`;
}

function collectParts(headerText, body, depth, out) {
  if (out.length >= MAX_PARTS) return;
  const headers = parseHeaders(headerText);
  const contentType = header(headers, 'content-type') || 'text/plain';
  const boundary = parameter(contentType, 'boundary');
  if (/^multipart\//i.test(contentType) && boundary && depth < MAX_DEPTH) {
    const delimiter = `--${boundary}`;
    const sections = body.split(delimiter).slice(1);
    for (const section of sections) {
      if (section.startsWith('--')) break;
      const { headerText: partHeaders, body: partBody } = splitHeaderBody(section.replace(/^\r?\n/, ''));
      collectParts(partHeaders, partBody.replace(/\r?\n$/, ''), depth + 1, out);
    }
    return;
  }
  const disposition = header(headers, 'content-disposition');
  const filename = parameter(disposition, 'filename') || parameter(contentType, 'name');
  out.push({
    contentType: contentType.split(';')[0].trim().toLowerCase(),
    charset: parameter(contentType, 'charset') || 'utf-8',
    filename,
    isAttachment: /^attachment/i.test(disposition) || Boolean(filename),
    content: decodeBody(body, header(headers, 'content-transfer-encoding')),
  });
}

/**
 * @param {Buffer|string} raw RFC 5322 message
 * @returns {{headers:Array<[string,string]>, from:string, replyTo:string, subject:string, text:string,
 *   attachments:Array<{filename:string, contentType:string, content:Buffer}>}}
 */
export function parseMimeMessage(raw) {
  const { headerText, body } = splitHeaderBody(raw);
  const headers = parseHeaders(headerText);
  const parts = [];
  collectParts(headerText, body, 0, parts);
  const textPart = parts.find((part) => !part.isAttachment && part.contentType === 'text/plain');
  const htmlPart = parts.find((part) => !part.isAttachment && part.contentType === 'text/html');
  let text = '';
  const contentOf = (part) => {
    try {
      return new TextDecoder(/utf-?8/i.test(part.charset) ? 'utf-8' : 'latin1').decode(part.content);
    } catch {
      return part.content.toString('utf8');
    }
  };
  const plainText = textPart ? contentOf(textPart) : '';
  const htmlText = htmlPart ? contentOf(htmlPart) : '';
  if (plainText.trim()) text = htmlPart ? appendHtmlOnlyLinks(plainText, htmlText) : plainText;
  else if (htmlPart) text = htmlToText(htmlText, { safeLinksOnly: true });
  else if (textPart) text = plainText;
  const replyToHeaders = headers.filter(([key]) => key === 'reply-to');
  return {
    headers,
    from: decodeEncodedWords(header(headers, 'from')),
    // Duplicate Reply-To fields are ambiguous and must fall back to From.
    replyTo: replyToHeaders.length === 1 ? decodeEncodedWords(replyToHeaders[0][1]) : '',
    subject: decodeEncodedWords(header(headers, 'subject')),
    text,
    attachments: parts.filter((part) => part.isAttachment).map(({ filename, contentType, content }) => ({ filename, contentType, content })),
  };
}

export function addressOf(value) {
  const match = /<([^>]+)>/.exec(String(value || '')) || /([^\s<>"]+@[^\s<>"]+)/.exec(String(value || ''));
  return match ? match[1].trim().toLowerCase() : '';
}

/** A single safe mailbox; address lists and malformed headers fail closed. */
export function singleMailboxAddress(value) {
  const text = decodeEncodedWords(String(value || '')).trim();
  if (!text || HEADER_CONTROL.test(text)) return '';
  const bracketed = [...text.matchAll(/<([^<>]+)>/g)];
  let candidate = '';
  if (bracketed.length === 1) {
    const mailboxMatch = /^(.*?)<([^<>]+)>$/.exec(text);
    if (!mailboxMatch || /[<>]/.test(mailboxMatch[1]) || mailboxMatch[1].includes('@')) return '';
    candidate = mailboxMatch[2].trim();
  } else if (bracketed.length === 0 && !/[\s,;<>]/.test(text)) {
    candidate = text;
  } else {
    return '';
  }
  if (!EMAIL_RE.test(candidate) || addressOf(candidate) !== candidate.toLowerCase()) return '';
  return candidate.toLowerCase();
}

const domainOf = (address) => String(address || '').split('@')[1]?.toLowerCase() || '';

function aligned(domain, fromDomain) {
  return Boolean(domain) && (domain === fromDomain || fromDomain.endsWith(`.${domain}`) || domain.endsWith(`.${fromDomain}`));
}

/**
 * Was the From address really the sender? Reads the Authentication-Results
 * the receiving MX (Cloudflare) added: DKIM pass for a domain aligned with
 * From, or SPF pass for an aligned envelope domain. Fails closed.
 */
export function senderAuthenticated(headers, fromAddress) {
  const fromDomain = domainOf(fromAddress);
  if (!fromDomain) return false;
  // Only the TOPMOST Authentication-Results counts: each receiving hop
  // prepends its own, so the first one is Cloudflare's MX. Any lower one may
  // have been written by the sender to fake a pass.
  const first = headers.find(([key]) => key === 'authentication-results');
  const results = first ? [first[1].toLowerCase()] : [];
  for (const result of results) {
    for (const match of result.matchAll(/dkim=pass[^;]*?header\.(?:d|i)=@?([a-z0-9.-]+)/g)) {
      if (aligned(match[1], fromDomain)) return true;
    }
    for (const match of result.matchAll(/spf=pass[^;]*?smtp\.mailfrom=(?:[^@;\s]*@)?([a-z0-9.-]+)/g)) {
      if (aligned(match[1], fromDomain)) return true;
    }
  }
  return false;
}
