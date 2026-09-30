/**
 * Minimal MIME reader for the inbound CV of the assisted application: the
 * candidate replies to valerie@ with the CV attached, the Cloudflare Email
 * Worker hands the raw message to assistedApplicationEmailCv.js.
 *
 * It reads what that flow needs and nothing more: top-level headers, the
 * leaf parts of (nested) multiparts, base64 / quoted-printable bodies,
 * attachment file names (RFC 2231 and RFC 2047), the first text/plain part,
 * and the sender-authentication verdict Cloudflare writes in
 * Authentication-Results. No dependency, so it deploys with the functions.
 */

const MAX_PARTS = 40;
const MAX_DEPTH = 4;

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

/** RFC 2047 encoded words (=?utf-8?B?...?= / =?utf-8?Q?...?=). */
export function decodeEncodedWords(value) {
  return String(value || '').replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_, charset, encoding, text) => {
    try {
      const bytes = encoding.toLowerCase() === 'b'
        ? Buffer.from(text, 'base64')
        : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, hex) => String.fromCharCode(Number.parseInt(hex, 16))), 'latin1');
      return new TextDecoder(/utf-?8/i.test(charset) ? 'utf-8' : 'latin1').decode(bytes);
    } catch {
      return text;
    }
  });
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
 * @returns {{headers:Array<[string,string]>, from:string, subject:string, text:string,
 *   attachments:Array<{filename:string, contentType:string, content:Buffer}>}}
 */
export function parseMimeMessage(raw) {
  const { headerText, body } = splitHeaderBody(raw);
  const headers = parseHeaders(headerText);
  const parts = [];
  collectParts(headerText, body, 0, parts);
  const textPart = parts.find((part) => !part.isAttachment && part.contentType === 'text/plain');
  let text = '';
  if (textPart) {
    try {
      text = new TextDecoder(/utf-?8/i.test(textPart.charset) ? 'utf-8' : 'latin1').decode(textPart.content);
    } catch {
      text = textPart.content.toString('utf8');
    }
  }
  return {
    headers,
    from: decodeEncodedWords(header(headers, 'from')),
    subject: decodeEncodedWords(header(headers, 'subject')),
    text,
    attachments: parts.filter((part) => part.isAttachment).map(({ filename, contentType, content }) => ({ filename, contentType, content })),
  };
}

export function addressOf(value) {
  const match = /<([^>]+)>/.exec(String(value || '')) || /([^\s<>"]+@[^\s<>"]+)/.exec(String(value || ''));
  return match ? match[1].trim().toLowerCase() : '';
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
