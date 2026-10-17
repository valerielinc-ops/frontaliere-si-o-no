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

/**
 * Try to pull articleBody / description / headline from any JSON-LD blocks.
 * Returns the longest articleBody-shaped string found, or null.
 */
function extractFromJsonLd(document) {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  let best = null;
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

function collectParagraphTexts(root, include = () => true) {
  return [...root.querySelectorAll(PARAGRAPH_SELECTOR)]
    .filter(p => include(p))
    .map(p => cleanText(p.textContent || ''))
    .filter(p => p && !isJunk(p));
}

function normalizeNoscriptRoot(noscript) {
  if (noscript.querySelector(PARAGRAPH_SELECTOR)) return noscript;

  const rawMarkup = noscript.textContent || '';
  if (!/<\/?[a-z][\s\S]*>/i.test(rawMarkup)) return noscript;

  const normalized = noscript.ownerDocument.createElement('div');
  normalized.innerHTML = rawMarkup;
  return normalized;
}

function hasNoscriptNonContentMarker(element) {
  if (element.hasAttribute('data-nosnippet')
    || element.hasAttribute('hidden')
    || element.getAttribute('aria-hidden') === 'true') {
    return true;
  }
  return [...element.attributes]
    .some(({ name, value }) => NOSCRIPT_NON_CONTENT_MARKER.test(`${name} ${value}`));
}

function hasNoscriptNonContentAncestor(node, root) {
  for (let current = node.parentElement; current; current = current.parentElement) {
    const tag = current.tagName.toLowerCase();
    if (NOSCRIPT_METADATA_TAGS.has(tag)
      || NOSCRIPT_TRACKING_TAGS.has(tag)
      || hasNoscriptNonContentMarker(current)) {
      return true;
    }
    if (current === root) break;
  }
  return false;
}

/**
 * Return true when a noscript block contains no unmarked article paragraphs.
 *
 * Noscript is also used for pixels, tag-manager fallbacks and head metadata.
 * Those blocks can contain a paragraph-shaped payload, so checking only the
 * element tag is not enough. Keep real fallback prose when at least one
 * paragraph is outside a metadata/tracking wrapper.
 */
function isNoscriptMetadata(noscript) {
  if (!noscript) return true;
  if (hasNoscriptNonContentMarker(noscript)) return true;

  const root = normalizeNoscriptRoot(noscript);
  const contentNodes = [...root.querySelectorAll(PARAGRAPH_SELECTOR)];
  if (contentNodes.length === 0) return true;

  return contentNodes.every(node => hasNoscriptNonContentAncestor(node, root));
}

/**
 * Normalize a noscript fallback whose nested markup was preserved as text.
 *
 * Depending on the HTML parser's scripting mode, a noscript body can be either
 * a normal element tree or one text node containing the serialized markup.
 * Parse the latter in a detached container so paragraph extraction has the
 * same shape in both cases. Setting innerHTML on a detached element does not
 * execute scripts or load the source page's resources.
 */
function extractNoscriptText(noscript) {
  if (!noscript) return [];

  const normalized = normalizeNoscriptRoot(noscript);
  const isEditorialParagraph = node => !hasNoscriptNonContentAncestor(node, normalized);
  if (normalized === noscript) return collectParagraphTexts(noscript, isEditorialParagraph);

  removeNoiseNodes(normalized);
  return collectParagraphTexts(normalized, isEditorialParagraph);
}

function extractParagraphs(root) {
  if (!root) return [];
  const paragraphs = [];
  const candidates = [...root.querySelectorAll(`${PARAGRAPH_SELECTOR}, noscript`)];
  for (const candidate of candidates) {
    if (candidate.tagName.toLowerCase() === 'noscript') {
      if (candidate.parentElement?.closest('noscript')) continue;
      if (isNoscriptMetadata(candidate)) continue;
      paragraphs.push(...extractNoscriptText(candidate));
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
  try {
    // No runScripts, no external resource loading, no CSS parsing chatter.
    // We only need the parsed DOM tree to walk for text nodes.
    const silentVirtualConsole = new (require_virtual_console_lazy())();
    silentVirtualConsole.on('jsdomError', () => {});
    dom = new JSDOM(html, { virtualConsole: silentVirtualConsole });
  } catch {
    return naiveFallback(html, maxChars);
  }
  const document = dom.window.document;
  const publishedAt = extractPublishedDate(document);

  // Strip noise nodes up-front. NOTE: JSON-LD `<script type="application/ld+json">`
  // MUST survive this pass — the JSON-LD extractor reads it next. We only purge
  // executable/styling script tags.
  removeNoiseNodes(document, { includeNoscript: opts.scriptingDisabled !== true });

  // 1. JSON-LD articleBody (most reliable)
  const jsonLdBody = extractFromJsonLd(document);
  if (jsonLdBody && jsonLdBody.length > 200) {
    const text = cleanText(jsonLdBody).slice(0, maxChars);
    return { text, method: 'jsonld', paragraphCount: text.split(/[.!?]\s+/).length, publishedAt };
  }

  // 2/3. Article-tag with paragraph extraction
  const articleParagraphs = extractParagraphs(document.querySelector('article'));
  if (articleParagraphs.length >= 2) {
    const text = articleParagraphs.join('\n\n').slice(0, maxChars);
    return { text, method: 'article-tag', paragraphCount: articleParagraphs.length, publishedAt };
  }

  // 4. Main-tag with paragraph extraction
  const mainParagraphs = extractParagraphs(document.querySelector('main'));
  if (mainParagraphs.length >= 2) {
    const text = mainParagraphs.join('\n\n').slice(0, maxChars);
    return { text, method: 'main-tag', paragraphCount: mainParagraphs.length, publishedAt };
  }

  // 5. OG description + first paragraphs anywhere
  const ogTitle = extractFromMeta(document, 'meta[property="og:title"]')
    || extractFromMeta(document, 'meta[name="title"]');
  const ogDesc = extractFromMeta(document, 'meta[property="og:description"]')
    || extractFromMeta(document, 'meta[name="description"]');
  const bodyParagraphs = extractParagraphs(document.body);
  if (ogDesc || bodyParagraphs.length >= 1) {
    const parts = [];
    if (ogTitle) parts.push(ogTitle);
    if (ogDesc) parts.push(ogDesc);
    parts.push(...bodyParagraphs.slice(0, 12));
    if (parts.join(' ').length >= 200) {
      const text = parts.join('\n\n').slice(0, maxChars);
      return { text, method: 'og-fallback', paragraphCount: parts.length, publishedAt };
    }
  }

  // 6. Last resort: legacy naive strip — preserves prior behaviour.
  return naiveFallback(html, maxChars);
}

function naiveFallback(html, maxChars) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
  return { text, method: 'naive-fallback', paragraphCount: 0 };
}
