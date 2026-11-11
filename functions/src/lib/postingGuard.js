/**
 * Deterministic posting guard for job postings (pasted text or fetched HTML),
 * ported from ai-job-search tools/posting_guard.py (MIT).
 *
 * Sanitizes third-party posting input before it reaches the AI drafting prompts:
 * - Strips and logs hidden CSS/HTML (display:none, visibility:hidden, opacity:0, font-size:0,
 *   offscreen positioning, zero-height/width with overflow:hidden, aria-hidden="true", hidden attr).
 * - Strips and scans invisible characters (zero-width characters, bidi overrides, format chars, BOM).
 * - Scans and decodes Unicode tag characters (U+E0000..U+E007F) used for ASCII smuggling / prompt injection.
 * - Flags instruction-shaped lines targeted at agents (e.g. "ignore previous instructions", "system:", etc.).
 * - Detects mixed-script homoglyphs (mixing Latin with Cyrillic or Greek in words).
 */

const EXCERPT = 120;
const LINE_MAX = 200;

const ZERO_WIDTH = '\u200B\u200C\u200D\u2060\u2061\u2062\u2063\u2064';
const BIDI = '\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069';
const BIDI_TAMPER = new Set(['\u202D', '\u202E', '\u2066\u2067\u2068\u2069']);
const FORMAT = '\u00AD\u2028\u2029';
const BOM = '\uFEFF';

const ZERO_WIDTH_SET = new Set(ZERO_WIDTH.split(''));
ZERO_WIDTH_SET.add(BOM);

// Tag characters U+E0000 to U+E007F
const TAG_RUN_RE = /[\u{E0000}-\u{E007F}]+/gu;

// Legitimate RGI subdivision flag emoji (England, Scotland, Wales)
const RGI_TAG_FLAG_RE = /\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}/gu;

const VARIATION_RE = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;
const VARIATION_RUN_RE = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]{2,}/gu;

const HIDDEN_STYLE_RE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d]*[1-9])|font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?(?![\d.])|color\s*:\s*transparent|clip\s*:\s*rect\(\s*0|clip-path\s*:\s*inset\(\s*100%|(?:(?:margin-)?(?:left|top)|text-indent)\s*:\s*-\d{4,}px)/i;

const PRESTRIP_RE = /<!DOCTYPE[^>]*>|<\?[^>]*\?>/gi;
const COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;
const DROP_BLOCKS_RE = /<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR_RE = /([^\s=\/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

const VOID_ELEMENTS = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'wbr', 'source', 'area', 'base', 'col', 'embed', 'param', 'track']);
const BLOCK_ELEMENTS = new Set([
  'p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'br', 'section', 'article',
  'header', 'footer', 'table', 'thead', 'tbody', 'blockquote', 'pre', 'dd', 'dt', 'dl', 'nav', 'main',
  'aside', 'figure', 'form', 'fieldset', 'legend', 'address', 'hr', 'td', 'th', 'option',
]);
const IMPLIED_END = new Set(['p', 'li', 'dd', 'dt', 'tr', 'td', 'th', 'option']);
const HTML_HINT_RE = /<\s*(html|body|div|p)\b/i;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

const INSTRUCTION_PATTERNS = [
  /\bignore\s+(all|any|the|previous|prior|above|earlier)\b/i,
  /\b(disregard|forget)(?:\s+(?:all|any|the|your|my))?\s+(previous|prior|above|earlier|preceding|initial|original|system)\s+(instructions?|prompts?)\b/i,
  /\byou\s+are\s+(?:an?|the)\s+(?:ai(?![\w-])|ai\s+(?:assistant|agent|model|language\s+model)|assistant|llm|language\s+model)\b/i,
  /\bsystem\s+prompt\b/i,
  /\b(do\s+not|don['’]?t|never)\s+(tell|inform)\s+the\s+user\b(?!['’]s)/i,
  /\b(do\s+not|don['’]?t|never)\s+(mention|reveal|disclose)\s+(this|these|that|it|any\s+of\s+this|the\s+(?:above|following|previous))\b[^.\n]{0,30}\bto\s+the\s+user\b/i,
  /\b(run|execute)\s+the\s+following\s+(command|commands|script|code|shell|instruction|instructions|steps)\b/i,
  /\bas\s+an\s+ai(?![\w-])(?![\s/&]+(?:[\w&/-]+\s+){0,3}?(?:engineer|developer|researcher|scientist|architect|specialist|lead|consultant|manager|analyst|intern|trainer|expert|strategist|designer|tester|owner|programmer)s?\b)/i,
  /^\s*(assistant|system|user)\s*:/im,
  /<\|/,
  /\[INST\]/,
  /###\s*(system|instruction)/i,
  /\b(curl|wget|ssh|scp)\b/i,
  /\.env\b/i,
  /settings\.json/i,
  /allowed-tools/i,
  /\btool_use\b|\bfunction_call\b/i,
];

const LATIN_RE = /[A-Za-z]/;
const CONFUSABLE_RE = /[\u0400-\u04FF\u0370-\u03FF]/; // Cyrillic & Greek
const CSS_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const COLLAPSED_BOX_RE = /\b(?:max-)?(?:height|width)\s*:\s*0(?:\.0+)?(?:px|em|rem|%|pt)?(?![\d.])/i;
const CLIPPED_RE = /\boverflow(?:-[xy])?\s*:\s*hidden\b/i;

function unescapeHtml(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

export function foldWhitespace(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t\xa0\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseAttrs(raw) {
  const out = {};
  ATTR_RE.lastIndex = 0;
  let match;
  while ((match = ATTR_RE.exec(raw)) !== null) {
    const key = match[1].toLowerCase();
    const val = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : (match[4] || '');
    out[key] = val;
  }
  return out;
}

function normalizeStyle(attrs) {
  return unescapeHtml(attrs.style || '').replace(CSS_COMMENT_RE, '');
}

function isElementHidden(attrsRaw) {
  const attrs = parseAttrs(attrsRaw);
  if ('hidden' in attrs || (attrs['aria-hidden'] || '').trim().toLowerCase() === 'true') {
    return true;
  }
  const style = normalizeStyle(attrs);
  if (HIDDEN_STYLE_RE.test(style)) {
    return true;
  }
  return COLLAPSED_BOX_RE.test(style) && CLIPPED_RE.test(style);
}

export function cleanText(text) {
  const raw = String(text || '');
  const counts = {};
  let flagged = 0;

  const countChars = (key, charSet) => {
    let count = 0;
    for (const ch of raw) {
      if (charSet.includes(ch)) count++;
    }
    if (count) counts[key] = count;
  };

  countChars('zero_width', ZERO_WIDTH);
  countChars('bidi', BIDI);
  countChars('format', FORMAT);
  countChars('bom', BOM);

  // Tag characters check
  RGI_TAG_FLAG_RE.lastIndex = 0;
  const unflagged = raw.replace(RGI_TAG_FLAG_RE, '');
  let tagCount = 0;
  for (const ch of unflagged) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xE0000 && cp <= 0xE007F) tagCount++;
  }
  if (tagCount) counts.tag = tagCount;

  VARIATION_RE.lastIndex = 0;
  const varMatches = raw.match(VARIATION_RE);
  if (varMatches && varMatches.length) counts.variation = varMatches.length;

  // Check character positions for tampering
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (BIDI_TAMPER.has(ch)) {
      flagged++;
    } else if (ZERO_WIDTH_SET.has(ch)) {
      const before = i > 0 ? raw[i - 1] : '';
      const after = i + 1 < raw.length ? raw[i + 1] : '';
      if (/\p{L}/u.test(before) && /\p{L}/u.test(after)) {
        flagged++;
      }
    }
  }

  // Decode tag runs
  const invisibleText = [];
  TAG_RUN_RE.lastIndex = 0;
  let tagRunMatch;
  while ((tagRunMatch = TAG_RUN_RE.exec(unflagged)) !== null) {
    const run = tagRunMatch[0];
    let decoded = '';
    for (const ch of run) {
      const ascii = ch.codePointAt(0) - 0xE0000;
      if (ascii >= 0x20 && ascii < 0x7F) decoded += String.fromCharCode(ascii);
    }
    decoded = decoded.trim();
    if (decoded) invisibleText.push(decoded.slice(0, LINE_MAX));
  }

  // Strip invisible chars while preserving valid flags
  const stripRegex = new RegExp(`[${ZERO_WIDTH}${BIDI}${FORMAT}${BOM}]|[\\u{E0000}-\\u{E007F}]|[\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}]`, 'gu');
  let cleaned = '';
  RGI_TAG_FLAG_RE.lastIndex = 0;
  let lastIdx = 0;
  let flagMatch;
  while ((flagMatch = RGI_TAG_FLAG_RE.exec(raw)) !== null) {
    const before = raw.slice(lastIdx, flagMatch.index);
    cleaned += before.replace(stripRegex, '') + flagMatch[0];
    lastIdx = RGI_TAG_FLAG_RE.lastIndex;
  }
  cleaned += raw.slice(lastIdx).replace(stripRegex, '');

  return {
    text: foldWhitespace(cleaned),
    findings: {
      invisible_chars: counts,
      invisible_flagged: flagged,
      invisible_text: invisibleText,
    },
  };
}

export function cleanHtml(markup) {
  let cleanMarkup = String(markup || '');
  const hiddenParts = [];
  const hiddenBlocks = [];

  cleanMarkup = cleanMarkup.replace(PRESTRIP_RE, ' ');
  cleanMarkup = cleanMarkup.replace(COMMENT_RE, (match) => {
    const inner = match.replace(/<!--|-->/g, ' ').replace(/<[^>]+>/g, ' ');
    hiddenParts.push(unescapeHtml(inner));
    return ' ';
  });
  cleanMarkup = cleanMarkup.replace(DROP_BLOCKS_RE, (match) => {
    const inner = match.replace(/<[^>]+>/g, ' ');
    hiddenParts.push(unescapeHtml(inner));
    return ' ';
  });

  const visible = [];
  const hiddenBuf = [];
  const stack = [];
  const navAt = new Set();
  let hiddenAt = null;
  let pos = 0;

  const emit = (str) => {
    (hiddenAt === null ? visible : hiddenBuf).push(str);
  };

  const flushHidden = () => {
    const block = foldWhitespace(unescapeHtml(hiddenBuf.join('')));
    hiddenBuf.length = 0;
    hiddenAt = null;
    if (block) {
      const { text: cleanedBlock } = cleanText(block);
      hiddenBlocks.push(cleanedBlock.slice(0, EXCERPT));
      hiddenParts.push(block);
    }
  };

  const popTo = (index) => {
    stack.splice(index);
    for (const idx of Array.from(navAt)) {
      if (idx >= index) navAt.delete(idx);
    }
    if (hiddenAt !== null && hiddenAt >= stack.length) {
      flushHidden();
    }
  };

  const lastIndex = (name) => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i] === name) return i;
    }
    return -1;
  };

  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(cleanMarkup)) !== null) {
    emit(cleanMarkup.slice(pos, m.index));
    pos = TAG_RE.lastIndex;

    const closing = m[1];
    const name = m[2].toLowerCase();
    const rawAttrs = m[3];

    if (BLOCK_ELEMENTS.has(name)) {
      emit('\n');
    }

    if (closing) {
      const idx = lastIndex(name);
      if (idx !== -1) popTo(idx);
      continue;
    }

    const attrs = parseAttrs(rawAttrs);
    const isNav = navAt.size > 0 || name === 'nav' || (attrs.role || '').trim().toLowerCase() === 'navigation';
    const isHidden = (hiddenAt !== null) || isElementHidden(rawAttrs);

    if (isHidden && !isNav) {
      URL_RE.lastIndex = 0;
      const urls = unescapeHtml(rawAttrs).match(URL_RE) || [];
      for (const u of urls) hiddenParts.push(u);
    }

    if (VOID_ELEMENTS.has(name)) continue;

    if (IMPLIED_END.has(name) && stack.length > 0 && stack[stack.length - 1] === name) {
      popTo(stack.length - 1);
    } else if (name !== 'br' && BLOCK_ELEMENTS.has(name) && stack.length > 0 && stack[stack.length - 1] === 'p') {
      popTo(stack.length - 1);
    }

    stack.push(name);
    const currentIdx = stack.length - 1;
    if (isNav) navAt.add(currentIdx);

    if (hiddenAt === null && isElementHidden(rawAttrs)) {
      hiddenAt = currentIdx;
    }
  }

  emit(cleanMarkup.slice(pos));
  if (hiddenAt !== null) flushHidden();

  const text = unescapeHtml(visible.join(''));
  return {
    text: foldWhitespace(text),
    findings: {
      hidden_blocks: hiddenBlocks,
      hidden_text: hiddenParts.join('\n'),
    },
  };
}

function excerpt(line, at) {
  if (line.length <= LINE_MAX) return line;
  const lead = Math.floor(LINE_MAX / 3);
  const start = Math.max(0, at - lead);
  const end = Math.min(line.length, start + LINE_MAX);
  const adjustedStart = Math.max(0, end - LINE_MAX);
  const head = adjustedStart ? '…' : '';
  const tail = end < line.length ? '…' : '';
  return `${head}${line.slice(adjustedStart, end)}${tail}`;
}

export function scanSecurity(visible, hidden) {
  const seen = new Set();
  const instructionLike = [];
  const lines = `${visible}\n${hidden}`.split(/\r?\n/);

  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped || seen.has(stripped)) continue;
    for (const pattern of INSTRUCTION_PATTERNS) {
      const match = pattern.exec(stripped);
      if (match) {
        seen.add(stripped);
        instructionLike.push(excerpt(stripped, match.index));
        break;
      }
    }
  }

  const hiddenUrls = [];
  URL_RE.lastIndex = 0;
  const hiddenMatches = hidden.match(URL_RE) || [];
  for (const u of hiddenMatches) {
    if (!hiddenUrls.includes(u)) hiddenUrls.push(u);
  }

  const homoglyphs = [];
  const words = `${visible}\n${hidden}`.match(/\p{L}+/gu) || [];
  for (const word of words) {
    if (LATIN_RE.test(word) && CONFUSABLE_RE.test(word) && !homoglyphs.includes(word)) {
      homoglyphs.push(word);
    }
  }

  URL_RE.lastIndex = 0;
  const visibleUrlCount = (visible.match(URL_RE) || []).length;

  return {
    instruction_like: instructionLike,
    hidden_urls: hiddenUrls,
    visible_url_count: visibleUrlCount,
    homoglyph_runs: homoglyphs,
  };
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

export function buildVerdict(findings) {
  const alarms = [];
  const nInstructions = (findings.instruction_like || []).length;
  if (nInstructions) alarms.push(plural(nInstructions, 'instruction-like line', 'instruction-like lines'));

  const nFlagged = Number(findings.invisible_flagged || 0);
  if (nFlagged) alarms.push(plural(nFlagged, 'invisible character inside words', 'invisible characters inside words'));

  const nTags = Number((findings.invisible_chars || {}).tag || 0);
  if (nTags) alarms.push(plural(nTags, 'tag character (text hidden from the reader)', 'tag characters (text hidden from the reader)'));

  const nInvisibleText = (findings.invisible_text || []).length;
  if (nInvisibleText) alarms.push(plural(nInvisibleText, 'string spelled in invisible characters', 'strings spelled in invisible characters'));

  const nHomoglyphs = (findings.homoglyph_runs || []).length;
  if (nHomoglyphs) alarms.push(plural(nHomoglyphs, 'mixed-script word', 'mixed-script words'));

  const context = [];
  const nHiddenBlocks = (findings.hidden_blocks || []).length;
  if (nHiddenBlocks) context.push(plural(nHiddenBlocks, 'hidden block', 'hidden blocks'));

  const nHiddenUrls = (findings.hidden_urls || []).length;
  if (nHiddenUrls) context.push(plural(nHiddenUrls, 'hidden URL', 'hidden URLs'));

  const removed = context.join(' and ');

  if (alarms.length > 0) {
    const line = `posting_guard: ⚠ ${alarms.join(', ')} - review before continuing`;
    return {
      isClean: false,
      verdict: removed ? `${line} (${removed} removed)` : line,
    };
  }
  if (removed) {
    return {
      isClean: true,
      verdict: `posting_guard: clean (${removed} removed, none instruction-like)`,
    };
  }
  return {
    isClean: true,
    verdict: 'posting_guard: clean',
  };
}

/**
 * Main guard entry point.
 * @param {string} raw - raw posting text or HTML.
 * @param {'auto'|'html'|'text'} [mode='auto'] - input mode.
 * @returns {{ cleanText: string, isClean: boolean, verdict: string, findings: object }}
 */
export function guardPosting(raw, mode = 'auto') {
  const input = String(raw || '');
  const chosenMode = mode === 'auto' ? (HTML_HINT_RE.test(input) ? 'html' : 'text') : mode;

  let text = '';
  let hiddenBlocks = [];
  let hiddenText = '';

  if (chosenMode === 'html') {
    const htmlRes = cleanHtml(input);
    text = htmlRes.text;
    hiddenBlocks = htmlRes.findings.hidden_blocks;
    hiddenText = htmlRes.findings.hidden_text;
  } else {
    text = input;
  }

  const { text: sanitizedText, findings: textFindings } = cleanText(text);
  const scanFindings = scanSecurity(sanitizedText, hiddenText);

  const findings = {
    ...textFindings,
    ...scanFindings,
    hidden_blocks: hiddenBlocks,
  };

  const { isClean, verdict } = buildVerdict(findings);

  return {
    cleanText: sanitizedText,
    isClean,
    verdict,
    findings,
  };
}
