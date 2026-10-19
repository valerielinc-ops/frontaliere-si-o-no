/**
 * extract-article-text.mjs — clean article-body extraction from HTML.
 *
 * Replaces the naive `html.replace(/<[^>]+>/g, ' ').slice(0, 8000)` extraction
 * in create-article.mjs which fed the model and the fact-checker 70%+ noise
 * (nav, ads, "altri articoli", footer). That noise was the structural root
 * cause of the fact-check rejection cascade: the model had to invent facts
 * because the real article body never reached it.
 *
 * Strategy (hierarchical, first non-empty wins):
 *   1. JSON-LD `articleBody` field (most reliable when present — RSI, CDT, Tio).
 *   2. Open Graph `og:description` + first N `<p>` tags inside `<article>` or
 *      `<main>` — works on most modern news sites.
 *   3. Plain `<article>` text content.
 *   4. Plain `<main>` text content.
 *   5. Fallback to legacy naive strip (preserves prior behavior so we never
 *      regress below the old baseline).
 *
 * The result is heavily-trimmed plain text capped at the caller's limit.
 * Junk patterns (cookie banners, "iscriviti alla newsletter", "leggi anche",
 * "potrebbe interessarti") are dropped from the final output.
 */

import { JSDOM, VirtualConsole } from 'jsdom';

// Lazy reference avoids breaking older jsdom that doesn't export VirtualConsole.
function require_virtual_console_lazy() {
  return VirtualConsole;
}

const JUNK_PATTERNS = [
  /cookie\s*polic(y|ies)/i,
  /accetta\s+i\s+cookie/i,
  /iscriviti\s+alla\s+newsletter/i,
  /leggi\s+anche/i,
  /potrebbe\s+(anche\s+)?interessarti/i,
  /articoli\s+correlati/i,
  /condividi\s+su/i,
  /privacy\s+polic(y|ies)/i,
  /termini\s+e\s+condizioni/i,
  /tutti\s+i\s+diritti\s+riservati/i,
  /scarica\s+l[''']app/i,
  /^\s*(home|menu|cerca|accedi|registrati|abbonati)\s*$/i,
];

const MIN_PARAGRAPH_LEN = 40;          // <40 chars → likely menu item
const MAX_DEFAULT_LEN   = 8000;

function isJunk(text) {
  const trimmed = text.trim();
  if (trimmed.length < MIN_PARAGRAPH_LEN) return true;
  return JUNK_PATTERNS.some(re => re.test(trimmed));
}

function cleanText(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function normalizeTextCap(maxChars) {
  const numeric = Number(maxChars);
  if (numeric === Number.POSITIVE_INFINITY) return numeric;
  if (!Number.isFinite(numeric)) return MAX_DEFAULT_LEN;
  return Math.max(0, Math.floor(numeric));
}

/**
 * Apply the extractor's hard character cap in one place.
 *
 * Keeping this separate from the route-specific joins is important for
 * `<noscript>`: a fallback paragraph can be much larger than the caller's
 * final source budget, so the collector must be able to cap it before it is
 * joined with sibling paragraphs.
 */
export function capExtractedText(text, maxChars = MAX_DEFAULT_LEN) {
  return String(text ?? '').slice(0, normalizeTextCap(maxChars));
}

/**
 * Try to pull articleBody / description / headline from any JSON-LD blocks.
 * Returns the longest articleBody-shaped string found, or null.
 */
function extractFromJsonLd(root, include = () => true) {
  const scripts = root.querySelectorAll('script[type="application/ld+json"]');
  let best = null;
  for (const script of scripts) {
    if (!include(script)) continue;
    let parsed;
    try {
      parsed = JSON.parse(script.textContent);
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const obj of candidates) {
      if (!obj || typeof obj !== 'object') continue;
      const graph = Array.isArray(obj['@graph']) ? obj['@graph'] : [obj];
      for (const node of graph) {
        if (!node || typeof node !== 'object') continue;
        const body = node.articleBody || node.text;
        if (typeof body === 'string' && body.length > 200) {
          if (!best || body.length > best.length) best = body;
        }
      }
    }
  }
  return best;
}

/**
 * Publication date of the SOURCE article, ISO string or ''.
 *
 * Added 2026-07-28: a 25 January 2026 source was republished as fresh news on
 * 28 July 2026, in the future tense, because nothing in the pipeline ever
 * looked at when the source was written. Reads JSON-LD `datePublished` first
 * then metadata explicitly labelled as publication. Creation, modification,
 * generic date metadata and unlabelled time elements do not establish when
 * the source was published; leave the date unknown instead of making it fresh.
 */
export function extractPublishedDate(document) {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    let parsed;
    try {
      parsed = JSON.parse(script.textContent);
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const obj of candidates) {
      if (!obj || typeof obj !== 'object') continue;
      const graph = Array.isArray(obj['@graph']) ? obj['@graph'] : [obj];
      for (const node of graph) {
        if (!node || typeof node !== 'object') continue;
        const raw = node.datePublished;
        if (typeof raw === 'string' && !Number.isNaN(new Date(raw).getTime())) {
          return new Date(raw).toISOString();
        }
      }
    }
  }

  for (const sel of ['meta[property="article:published_time"]',
                     'meta[itemprop="datePublished"]', 'meta[name="pubdate"]']) {
    const el = document.querySelector(sel);
    const raw = el ? (el.getAttribute('content') || '').trim() : '';
    if (raw && !Number.isNaN(new Date(raw).getTime())) return new Date(raw).toISOString();
  }

  const timeEl = document.querySelector('time[itemprop~="datePublished"][datetime]');
  const timeRaw = timeEl ? (timeEl.getAttribute('datetime') || '').trim() : '';
  if (timeRaw && !Number.isNaN(new Date(timeRaw).getTime())) return new Date(timeRaw).toISOString();

  return '';
}

function extractFromMeta(document, selector) {
  const el = document.querySelector(selector);
  return el ? (el.getAttribute('content') || '').trim() : '';
}

const PARAGRAPH_SELECTOR = 'p, h2, h3, h4, li, blockquote';
const NOISE_SELECTORS = [
  'script:not([type="application/ld+json"])', 'style', 'iframe', 'nav', 'footer',
  'aside', 'form', '[class*="cookie" i]', '[id*="cookie" i]',
  '[class*="banner" i]', '[class*="related" i]',
  '[class*="newsletter" i]', '[class*="advert" i]',
  '[class*="adsbygoogle" i]',
];

const NOSCRIPT_METADATA_TAGS = new Set(['base', 'link', 'meta', 'script', 'style', 'title']);
const NOSCRIPT_TRACKING_TAGS = new Set(['embed', 'iframe', 'img', 'object', 'source', 'track']);
const NOSCRIPT_NON_CONTENT_MARKER = /\b(?:ad(?:s|vert(?:isement)?s?)?|analytics?|beacon|consent|gtm|metadata|nosnippet|pixel|tag[-_ ]?manager|track(?:ing)?(?:[-_ ]?pixel)?)\b/i;

function removeNoiseNodes(root, { includeNoscript = false } = {}) {
  const selectors = includeNoscript ? [...NOISE_SELECTORS, 'noscript'] : NOISE_SELECTORS;
  for (const sel of selectors) {
    for (const el of root.querySelectorAll(sel)) el.remove();
  }
}

function collectParagraphTexts(root, include = () => true, maxChars = Number.POSITIVE_INFINITY) {
  return [...root.querySelectorAll(PARAGRAPH_SELECTOR)]
    .filter(node => include(node))
    .map(node => cleanText(node.textContent || ''))
    .filter(text => text && !isJunk(text))
    .map(text => capExtractedText(text, maxChars))
    .filter(Boolean);
}

const NOSCRIPT_RAW_TEXT_TOKEN_RE = /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext)\b[^>]*>/gi;
const NOSCRIPT_RECOVERABLE_TAIL_RE = /^<(p|h2|h3|h4|li|blockquote)\b[^>]*>/i;
const NOSCRIPT_END_TAG_RE = /^<\/noscript\s*>/i;
const NOSCRIPT_REGEX_PREFIX_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'extends', 'in', 'instanceof',
  'new', 'of', 'return', 'throw', 'typeof', 'void', 'yield',
]);
const NOSCRIPT_CONTROL_FLOW_KEYWORDS = new Set(['catch', 'for', 'if', 'switch', 'while', 'with']);
const JS_IDENTIFIER_START_RE = /[A-Za-z_$]/;
const JS_IDENTIFIER_PART_RE = /[A-Za-z0-9_$]/;

function findUnclosedNoscriptRawTextElement(markup) {
  const rawTextOpening = new RegExp(NOSCRIPT_RAW_TEXT_TOKEN_RE.source, 'gi');
  let opening;
  while ((opening = rawTextOpening.exec(markup))) {
    // A raw-text-looking opener inside an HTML comment is not an element and
    // must not poison the rest of the noscript fallback.
    if (!opening[1]) continue;
    const tag = opening[1].toLowerCase();
    if (tag === 'plaintext') {
      return { contentStart: rawTextOpening.lastIndex, tag };
    }

    const closing = new RegExp(`</${tag}\\s*>`, 'gi');
    closing.lastIndex = rawTextOpening.lastIndex;
    const match = closing.exec(markup);
    if (!match) return { contentStart: rawTextOpening.lastIndex, tag };
    rawTextOpening.lastIndex = closing.lastIndex;
  }
  return null;
}

function hasClosedNoscriptRawTextElements(markup) {
  return findUnclosedNoscriptRawTextElement(markup) === null;
}

function findNoscriptEndTagOutsideLexicalState(markup, contentStart) {
  let state = 'code';
  // A slash starts a regexp only where JavaScript expects an expression. A
  // plain division such as `4 / 2` must leave the scanner in code so that the
  // real `</noscript>` boundary remains visible.
  let canStartRegex = true;
  let pendingControlFlowParen = false;
  const parenContexts = [];
  for (let index = contentStart; index < markup.length; index += 1) {
    const char = markup[index];
    const next = markup[index + 1];

    if (state === 'template') {
      // Nested template/interpolation parsing is intentionally unsupported:
      // never recover an outer boundary after entering this lexical state.
      return -1;
    }

    if (state === 'single-quote' || state === 'double-quote') {
      if (char === '\\') {
        index += 1;
      } else if ((state === 'single-quote' && char === "'")
        || (state === 'double-quote' && char === '"')) {
        state = 'code';
        canStartRegex = false;
      }
      continue;
    }

    if (state === 'line-comment') {
      if (char === '\n' || char === '\r') state = 'code';
      continue;
    }

    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        state = 'code';
        index += 1;
      }
      continue;
    }

    if (state === 'regex-literal' || state === 'regex-character-class') {
      if (char === '\\') {
        index += 1;
      } else if (state === 'regex-literal' && char === '[') {
        state = 'regex-character-class';
      } else if (state === 'regex-character-class' && char === ']') {
        state = 'regex-literal';
      } else if (state === 'regex-literal' && char === '/') {
        state = 'code';
        canStartRegex = false;
      }
      continue;
    }

    if (state === 'html-comment') {
      if (markup.startsWith('-->', index)) {
        state = 'code';
        canStartRegex = true;
        index += 2;
      }
      continue;
    }

    if (markup.startsWith('</noscript', index)) {
      const endTag = NOSCRIPT_END_TAG_RE.exec(markup.slice(index));
      if (endTag) return index + endTag[0].length;
    }

    if (char === "'") {
      state = 'single-quote';
      pendingControlFlowParen = false;
    } else if (char === '"') {
      state = 'double-quote';
      pendingControlFlowParen = false;
    } else if (char === '`') {
      // A template literal may contain nested interpolation/templates; fail
      // closed instead of trying to tokenize only part of JavaScript.
      return -1;
    } else if (char === '/' && next === '/') {
      state = 'line-comment';
      index += 1;
    } else if (char === '/' && next === '*') {
      state = 'block-comment';
      index += 1;
    } else if (char === '/') {
      if (canStartRegex) {
        state = 'regex-literal';
      } else {
        // Division consumes an operator position and the next token is an
        // expression, which may itself be a regexp literal.
        canStartRegex = true;
      }
    } else if (markup.startsWith('<!--', index)) {
      state = 'html-comment';
      index += 3;
      canStartRegex = true;
      pendingControlFlowParen = false;
    } else if (/\s/u.test(char)) {
      continue;
    } else if (JS_IDENTIFIER_START_RE.test(char)) {
      let end = index + 1;
      while (end < markup.length && JS_IDENTIFIER_PART_RE.test(markup[end])) end += 1;
      const word = markup.slice(index, end);
      canStartRegex = NOSCRIPT_REGEX_PREFIX_KEYWORDS.has(word);
      pendingControlFlowParen = NOSCRIPT_CONTROL_FLOW_KEYWORDS.has(word);
      index = end - 1;
    } else if (/[0-9]/u.test(char)) {
      canStartRegex = false;
      pendingControlFlowParen = false;
    } else if ('([{'.includes(char)) {
      if (char === '(') parenContexts.push(pendingControlFlowParen);
      pendingControlFlowParen = false;
      canStartRegex = true;
    } else if (')]}'.includes(char)) {
      if (char === ')' && parenContexts.length > 0) {
        canStartRegex = parenContexts.pop();
      } else {
        canStartRegex = false;
      }
      pendingControlFlowParen = false;
    } else if ((char === '+' || char === '-') && next === char) {
      // Both prefix and postfix ++/-- produce a value before a following
      // slash, so treating the pair as an expression keeps division safe.
      canStartRegex = false;
      pendingControlFlowParen = false;
      index += 1;
    } else if (',;:?=!.~*%&|^<>'.includes(char)) {
      canStartRegex = true;
      pendingControlFlowParen = false;
    }
  }
  return -1;
}

function findReliableNoscriptTailBoundary(markup, tailStart) {
  const opening = NOSCRIPT_RECOVERABLE_TAIL_RE.exec(markup.slice(tailStart));
  if (!opening) return null;

  const closing = new RegExp(`^</${opening[1]}\\s*>`, 'i');
  const content = markup.slice(tailStart + opening[0].length);
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char === '<') {
      // Only the close for the immediate opener is a source-level boundary.
      // Any other markup could be a comparison or a lexical payload.
      const closingMatch = closing.exec(content.slice(index));
      return closingMatch
        ? {
          start: tailStart,
          end: tailStart + opening[0].length + index + closingMatch[0].length,
        }
        : null;
    }

    // Quotes, JSON delimiters, slashes/comments and code punctuation make a
    // closing tag ambiguous: it may belong to JavaScript rather than this
    // plain HTML tail.
    if ('"\'`{}[]();=\\/'.includes(char)) {
      return null;
    }
  }
  return null;
}

function hasSafeNoscriptTailSuffix(markup, tailEnd) {
  return /^\s*(?:<\/noscript\s*>)?\s*$/i.test(markup.slice(tailEnd));
}

function findRecoverableNoscriptTail(markup, contentStart, rawTextTag) {
  if (rawTextTag !== 'script') return -1;
  const leadingWhitespace = markup.slice(contentStart).match(/^\s*/u)?.[0].length || 0;
  const tailStart = contentStart + leadingWhitespace;

  // A code prefix such as `a<p>b` is valid JavaScript comparison syntax. Do
  // not scan past it looking for a later paragraph-shaped token.
  const boundary = findReliableNoscriptTailBoundary(markup, tailStart);
  return boundary && hasSafeNoscriptTailSuffix(markup, boundary.end)
    ? boundary.start
    : -1;
}

/**
 * Normalize a noscript fallback whose nested markup was preserved as text.
 * Raw-text elements consume everything after an unmatched opening tag, so an
 * unclosed one rejects the whole block instead of returning a parser-dependent
 * fragment. Detached innerHTML parsing does not execute scripts or load assets.
 */
function parseNoscriptFallback(noscript, sourceMarkup) {
  // Validate the original bytes before consulting the DOM: an unclosed
  // raw-text element can change the tree JSDOM exposes after the damage.
  if (typeof sourceMarkup !== 'string' || !hasClosedNoscriptRawTextElements(sourceMarkup)) {
    return null;
  }
  if (noscript.querySelector(`${PARAGRAPH_SELECTOR}, script[type="application/ld+json"]`)) {
    return noscript;
  }

  const rawMarkup = noscript.textContent || '';
  if (!/<\/?[a-z][\s\S]*>/i.test(rawMarkup)) return noscript;
  if (!hasClosedNoscriptRawTextElements(rawMarkup)) return null;

  const normalized = noscript.ownerDocument.createElement('div');
  normalized.innerHTML = rawMarkup;
  return normalized;
}

function hasNoscriptNonContentMarker(element, { allowTrackIdValueOnly = false } = {}) {
  if (element.hasAttribute('data-nosnippet')
    || element.hasAttribute('hidden')
    || element.getAttribute('aria-hidden') === 'true') {
    return true;
  }
  return [...element.attributes]
    .some(({ name, value }) => {
      // Instrumentation IDs such as data-track-id="story-1" are valid only on
      // the editorial candidate itself. On wrappers/ancestors the attribute
      // name remains a tracking marker even when its value is just a number.
      const markerSource = allowTrackIdValueOnly && /^data-track-id$/i.test(name)
        ? value
        : `${name} ${value}`;
      return NOSCRIPT_NON_CONTENT_MARKER.test(markerSource);
    });
}

function hasNoscriptNonContentAncestor(
  node,
  root,
  { allowCandidateMetadataTag = false, allowCandidateTrackIdValueOnly = false } = {},
) {
  for (let current = node; current; current = current.parentElement) {
    const tag = current.tagName.toLowerCase();
    const candidateTagIsAllowed = allowCandidateMetadataTag && current === node;
    const candidateTrackIdIsAllowed = allowCandidateTrackIdValueOnly && current === node;
    if ((!candidateTagIsAllowed && NOSCRIPT_METADATA_TAGS.has(tag))
      || (!candidateTagIsAllowed && NOSCRIPT_TRACKING_TAGS.has(tag))
      || hasNoscriptNonContentMarker(current, {
        allowTrackIdValueOnly: candidateTrackIdIsAllowed,
      })) {
      return true;
    }
    if (current === root) break;
  }
  return false;
}

function noscriptJsonLdIsEditorial(script, root) {
  return !hasNoscriptNonContentAncestor(script, root, {
    allowCandidateMetadataTag: true,
    allowCandidateTrackIdValueOnly: true,
  });
}

function emptyNoscriptFallback() {
  return { paragraphs: [], jsonLdBody: null, legacyText: '' };
}

function extractNoscriptLegacyText(root) {
  const clone = root.cloneNode(true);
  for (const element of clone.querySelectorAll('*')) {
    const tag = element.tagName.toLowerCase();
    if (NOSCRIPT_METADATA_TAGS.has(tag)
      || NOSCRIPT_TRACKING_TAGS.has(tag)
      || hasNoscriptNonContentMarker(element)) {
      element.remove();
    }
  }
  return cleanText(clone.textContent || '');
}

function inspectNoscriptFallback(noscript, maxChars, sourceMarkup) {
  if (!noscript || hasNoscriptNonContentAncestor(noscript, noscript.ownerDocument.documentElement)) {
    return emptyNoscriptFallback();
  }

  const root = parseNoscriptFallback(noscript, sourceMarkup);
  if (!root) return emptyNoscriptFallback();
  if (root !== noscript) removeNoiseNodes(root);

  return {
    paragraphs: collectParagraphTexts(
      root,
      node => !hasNoscriptNonContentAncestor(node, root, {
        allowCandidateTrackIdValueOnly: true,
      }),
      maxChars,
    ),
    jsonLdBody: extractFromJsonLd(root, script => noscriptJsonLdIsEditorial(script, root)),
    legacyText: extractNoscriptLegacyText(root),
  };
}

function topLevelNoscripts(root) {
  return [...root.querySelectorAll('noscript')]
    .filter(node => !node.parentElement?.closest('noscript'));
}

function areAdjacentNoscripts(previous, current) {
  if (!previous || previous.parentNode !== current.parentNode) return false;
  let sibling = previous.nextSibling;
  while (sibling && sibling !== current) {
    const isWhitespace = sibling.nodeType === 3 && !sibling.textContent.trim();
    const isComment = sibling.nodeType === 8;
    if (!isWhitespace && !isComment) return false;
    sibling = sibling.nextSibling;
  }
  return sibling === current;
}

function mergeNoscriptFallbackBlocks(root, maxChars, sourceMarkupByNode) {
  const states = new Map();
  const paragraphsByNode = new Map();
  const jsonLdBodies = [];
  let group = [];

  const flush = () => {
    if (group.length === 0) return;
    // An adjacent run is one ordered fallback. Tracking-only members add no
    // paragraphs, while editorial members retain their original DOM order.
    const [first, ...rest] = group;
    paragraphsByNode.set(first, group.flatMap(node => states.get(node).paragraphs));
    for (const node of rest) paragraphsByNode.set(node, []);
    group = [];
  };

  let previous = null;
  for (const noscript of topLevelNoscripts(root)) {
    const state = inspectNoscriptFallback(noscript, maxChars, sourceMarkupByNode.get(noscript));
    states.set(noscript, state);
    if (state.jsonLdBody) jsonLdBodies.push(state.jsonLdBody);

    if (!areAdjacentNoscripts(previous, noscript)) flush();
    group.push(noscript);
    previous = noscript;
  }
  flush();

  return { states, paragraphsByNode, jsonLdBodies };
}

function selectNoscriptJsonLdPrecedence(document, fallbacks) {
  const bodies = [
    extractFromJsonLd(document, script => !script.closest('noscript')),
    ...fallbacks.jsonLdBodies,
  ].filter(Boolean);

  return bodies.reduce((best, body) => (!best || body.length > best.length ? body : best), null);
}

function safeNoscriptNaiveFallback(document, fallbacks, maxChars) {
  const sourceNoscripts = topLevelNoscripts(document.body);
  const clone = document.body.cloneNode(true);
  const clonedNoscripts = topLevelNoscripts(clone);

  for (let index = 0; index < clonedNoscripts.length; index += 1) {
    const state = fallbacks.states.get(sourceNoscripts[index]);
    const text = state?.paragraphs.join(' ') || state?.legacyText || '';
    if (text) {
      clonedNoscripts[index].replaceWith(clone.ownerDocument.createTextNode(` ${text} `));
    } else {
      clonedNoscripts[index].remove();
    }
  }

  for (const node of clone.querySelectorAll('script, style')) node.remove();
  const text = capExtractedText(cleanText(clone.textContent || ''), maxChars);
  return { text, method: 'naive-fallback', paragraphCount: 0 };
}

function prepareNoscriptSource(html) {
  const sourceDom = new JSDOM(html, { includeNodeLocations: true });
  const sourceMarkup = [];
  const rejectedRanges = [];

  try {
    for (const noscript of sourceDom.window.document.querySelectorAll('noscript')) {
      const location = sourceDom.nodeLocation(noscript);
      const markup = location?.startTag && location?.endTag
        ? html.slice(location.startTag.endOffset, location.endTag.startOffset)
        : null;
      if (typeof markup === 'string' && hasClosedNoscriptRawTextElements(markup)) {
        sourceMarkup.push(markup);
      } else if (location) {
        let rejectedEnd = location.endOffset;
        if (location.startTag) {
          const unterminatedMarkup = html.slice(location.startTag.endOffset);
          const rawText = findUnclosedNoscriptRawTextElement(unterminatedMarkup);
          if (rawText) {
            // parse5 reports a zero-width noscript when both raw-text and
            // noscript stay open. A literal end tag is usable only when a
            // source scanner reaches it outside every JavaScript lexical
            // state; otherwise the whole suffix remains poisoned.
            const noscriptEnd = rawText.tag === 'script'
              ? findNoscriptEndTagOutsideLexicalState(
                unterminatedMarkup,
                rawText.contentStart,
              )
              : -1;
            const tailBoundary = rawText.tag === 'script'
              ? findReliableNoscriptTailBoundary(
                unterminatedMarkup,
                rawText.contentStart
                  + (unterminatedMarkup.slice(rawText.contentStart).match(/^\s*/u)?.[0].length || 0),
              )
              : null;
            const tailIsSafe = !tailBoundary
              || hasSafeNoscriptTailSuffix(unterminatedMarkup, tailBoundary.end);
            if (noscriptEnd >= 0) {
              rejectedEnd = tailIsSafe ? location.startTag.endOffset + noscriptEnd : html.length;
            } else {
              const tailOffset = tailIsSafe
                ? findRecoverableNoscriptTail(
                  unterminatedMarkup,
                  rawText.contentStart,
                  rawText.tag,
                )
                : -1;
              rejectedEnd = tailOffset >= 0
                ? location.startTag.endOffset + tailOffset
                : html.length;
            }
          } else {
            rejectedEnd = html.length;
          }
        }
        rejectedRanges.push([location.startOffset, rejectedEnd]);
      }
    }
  } finally {
    sourceDom.window.close();
  }

  if (rejectedRanges.length === 0) return { parsedHtml: html, sourceMarkup };

  let cursor = 0;
  let parsedHtml = '';
  for (const [start, end] of rejectedRanges.sort((a, b) => a[0] - b[0])) {
    parsedHtml += html.slice(cursor, start);
    parsedHtml += html.slice(start, end).replace(/[^\r\n]/g, ' ');
    cursor = end;
  }
  parsedHtml += html.slice(cursor);
  return { parsedHtml, sourceMarkup };
}

function extractParagraphs(root, maxChars = Number.POSITIVE_INFINITY, fallbacks = null) {
  if (!root) return [];
  const paragraphs = [];
  const candidates = [...root.querySelectorAll(`${PARAGRAPH_SELECTOR}, noscript`)];

  for (const candidate of candidates) {
    if (candidate.tagName.toLowerCase() === 'noscript') {
      if (candidate.parentElement?.closest('noscript')) continue;
      paragraphs.push(...(fallbacks?.paragraphsByNode.get(candidate) || []));
      continue;
    }
    if (candidate.closest('noscript')) continue;
    const text = cleanText(candidate.textContent || '');
    if (text && !isJunk(text)) paragraphs.push(text);
  }

  // Dedup adjacent identical paragraphs (some sites repeat the lead)
  const out = [];
  for (const p of paragraphs) {
    if (out.length === 0 || out[out.length - 1] !== p) out.push(p);
  }
  return out;
}

/**
 * Extract clean article text from raw HTML.
 *
 * @param {string} html — raw HTML page source
 * @param {object} [opts]
 * @param {number} [opts.maxChars=8000] — hard cap on output length
 * @param {boolean} [opts.scriptingDisabled=false] — treat `<noscript>` markup as active fallback content
 * @returns {{ text: string, method: string, paragraphCount: number }}
 *          `method` is one of 'jsonld', 'article-tag', 'main-tag',
 *          'og-fallback', 'naive-fallback', 'empty'.
 */
export function extractArticleText(html, opts = {}) {
  const maxChars = Number(opts.maxChars || MAX_DEFAULT_LEN);
  if (!html || typeof html !== 'string') {
    return { text: '', method: 'empty', paragraphCount: 0 };
  }

  let dom;
  let parsedHtml = html;
  let sourceMarkup = [];
  try {
    // No runScripts, no external resource loading, no CSS parsing chatter.
    // We only need the parsed DOM tree to walk for text nodes.
    const silentVirtualConsole = new (require_virtual_console_lazy())();
    silentVirtualConsole.on('jsdomError', () => {});
    if (opts.scriptingDisabled === true) {
      ({ parsedHtml, sourceMarkup } = prepareNoscriptSource(html));
    }
    dom = new JSDOM(parsedHtml, { virtualConsole: silentVirtualConsole });
  } catch {
    return naiveFallback(html, maxChars);
  }
  const document = dom.window.document;
  const publishedAt = extractPublishedDate(document);
  const noscriptSourceMarkup = new WeakMap();

  if (opts.scriptingDisabled === true) {
    const parsedNodes = [...document.querySelectorAll('noscript')];
    for (let index = 0; index < parsedNodes.length; index += 1) {
      noscriptSourceMarkup.set(parsedNodes[index], sourceMarkup[index] ?? null);
    }
  }

  // Strip noise nodes up-front. NOTE: JSON-LD `<script type="application/ld+json">`
  // MUST survive this pass — the JSON-LD extractor reads it next. We only purge
  // executable/styling script tags.
  removeNoiseNodes(document, { includeNoscript: opts.scriptingDisabled !== true });
  const noscriptFallbacks = opts.scriptingDisabled === true
    ? mergeNoscriptFallbackBlocks(document, maxChars, noscriptSourceMarkup)
    : null;

  // 1. JSON-LD articleBody (most reliable)
  const jsonLdBody = noscriptFallbacks
    ? selectNoscriptJsonLdPrecedence(document, noscriptFallbacks)
    : extractFromJsonLd(document);
  if (jsonLdBody && jsonLdBody.length > 200) {
    const text = capExtractedText(cleanText(jsonLdBody), maxChars);
    return { text, method: 'jsonld', paragraphCount: text.split(/[.!?]\s+/).length, publishedAt };
  }

  // 2/3. Article-tag with paragraph extraction
  const articleParagraphs = extractParagraphs(document.querySelector('article'), maxChars, noscriptFallbacks);
  if (articleParagraphs.length >= 2) {
    const text = capExtractedText(articleParagraphs.join('\n\n'), maxChars);
    return { text, method: 'article-tag', paragraphCount: articleParagraphs.length, publishedAt };
  }

  // 4. Main-tag with paragraph extraction
  const mainParagraphs = extractParagraphs(document.querySelector('main'), maxChars, noscriptFallbacks);
  if (mainParagraphs.length >= 2) {
    const text = capExtractedText(mainParagraphs.join('\n\n'), maxChars);
    return { text, method: 'main-tag', paragraphCount: mainParagraphs.length, publishedAt };
  }

  // 5. OG description + first paragraphs anywhere
  const ogTitle = extractFromMeta(document, 'meta[property="og:title"]')
    || extractFromMeta(document, 'meta[name="title"]');
  const ogDesc = extractFromMeta(document, 'meta[property="og:description"]')
    || extractFromMeta(document, 'meta[name="description"]');
  const bodyParagraphs = extractParagraphs(document.body, maxChars, noscriptFallbacks);
  if (ogDesc || bodyParagraphs.length >= 1) {
    const parts = [];
    if (ogTitle) parts.push(ogTitle);
    if (ogDesc) parts.push(ogDesc);
    parts.push(...bodyParagraphs.slice(0, 12));
    if (parts.join(' ').length >= 200) {
      const text = capExtractedText(parts.join('\n\n'), maxChars);
      return { text, method: 'og-fallback', paragraphCount: parts.length, publishedAt };
    }
  }

  // 6. Last resort: legacy naive strip — preserves prior behaviour.
  if (noscriptFallbacks) return safeNoscriptNaiveFallback(document, noscriptFallbacks, maxChars);
  return naiveFallback(html, maxChars);
}

function naiveFallback(html, maxChars) {
  const text = capExtractedText(html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim(), maxChars);
  return { text, method: 'naive-fallback', paragraphCount: 0 };
}
