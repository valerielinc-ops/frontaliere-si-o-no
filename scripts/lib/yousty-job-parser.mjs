import { JSDOM } from 'jsdom';
import { decode as decodeHtmlEntities } from 'html-entities';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

const YOUSTY_PROFILE_PATH_RE = /^\/(?:[a-z]{2}-[a-z]{2}\/)?(?:lehrstellen\/profile|places-d-apprentissage\/profils|posti-di-apprendistato\/profili)\/[^/?#]+\/?$/i;
const YOUSTY_WIDGET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Inline markup must stay inside its sentence: the previous walker pushed
// every child node as its own paragraph, so `<p><strong>5 Wochen Ferien</strong>,
// mit der Möglichkeit …</p>` came out as "5 Wochen Ferien\n\n, mit der …".
const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'em', 'font', 'i', 'mark', 'small', 'span', 'strong', 'sub', 'sup', 'u']);

function inlineText(node) {
  if (node.nodeType === 3) return String(node.textContent || '');
  if (node.nodeType !== 1) return '';
  const tag = String(node.tagName || '').toLowerCase();
  if (tag === 'br') return '\n';
  return Array.from(node.childNodes || []).map(inlineText).join('');
}

function isInlineNode(node) {
  if (node.nodeType === 3) return true;
  if (node.nodeType !== 1) return false;
  const tag = String(node.tagName || '').toLowerCase();
  return tag === 'br' || INLINE_TAGS.has(tag);
}

function htmlToTextBlock(element) {
  if (!element) return '';
  const parts = [];
  let inline = '';
  const flushInline = () => {
    const text = inline
      .split('\n')
      .map((line) => normalizeSpace(line))
      .filter(Boolean)
      .join('\n');
    if (text) parts.push(text);
    inline = '';
  };

  for (const node of Array.from(element.childNodes || [])) {
    if (isInlineNode(node)) {
      inline += inlineText(node);
      continue;
    }
    if (node.nodeType !== 1) continue;
    flushInline();
    const tag = String(node.tagName || '').toLowerCase();

    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(node.querySelectorAll(':scope > li'))
        .map((li) => normalizeSpace(li.textContent || ''))
        .filter(Boolean)
        .map((item) => `- ${item}`);
      if (items.length > 0) parts.push(items.join('\n'));
      continue;
    }

    if (/^h[1-6]$/.test(tag)) {
      const heading = normalizeSpace(node.textContent || '');
      if (heading) parts.push(heading);
      continue;
    }

    const nested = htmlToTextBlock(node);
    if (nested) parts.push(nested);
  }
  flushInline();

  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Markdown for an HTML fragment of the source (Solique textblocks, Yousty
 * noscript sections): paragraphs separated by a blank line, `<ul>/<ol>` kept as
 * `- ` items, inline markup kept inline, `<br>` as a line break.
 */
export function htmlFragmentToMarkdown(html = '') {
  const source = String(html || '').trim();
  if (!source) return '';
  return htmlToTextBlock(JSDOM.fragment(source));
}

function flattenJsonLd(value) {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (!value || typeof value !== 'object') return [];

  const graph = value['@graph'] ? flattenJsonLd(value['@graph']) : [];
  return [value, ...graph];
}

function isJobPosting(value) {
  const types = Array.isArray(value?.['@type']) ? value['@type'] : [value?.['@type']];
  return types.some((type) => {
    const normalized = String(type || '').trim().toLowerCase();
    return normalized === 'jobposting' || normalized === 'https://schema.org/jobposting';
  });
}

function isHtmlSpace(character) {
  return character === ' ' || character === '\t' || character === '\n' || character === '\f' || character === '\r';
}

function isHtmlTagNameCharacter(character) {
  if (!character) return false;
  const code = character.charCodeAt(0);
  return (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || (code >= 0x30 && code <= 0x39)
    || character === ':'
    || character === '-'
    || character === '_';
}

function readHtmlTagName(source, start) {
  let index = start;
  while (index < source.length && isHtmlTagNameCharacter(source[index])) index += 1;
  return source.slice(start, index).toLowerCase();
}

function findHtmlTagEnd(source, start) {
  let quote = '';
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return index;
  }
  return -1;
}

function findHtmlClosingTag(source, start, wantedName) {
  let searchStart = start;
  while (searchStart < source.length) {
    const candidate = source.indexOf('<', searchStart);
    if (candidate < 0) return null;
    if (source[candidate + 1] !== '/') {
      searchStart = candidate + 1;
      continue;
    }

    const nameStart = candidate + 2;
    const name = readHtmlTagName(source, nameStart);
    const boundary = source[nameStart + name.length];
    if (name !== wantedName || (boundary !== '>' && !isHtmlSpace(boundary))) {
      searchStart = candidate + 1;
      continue;
    }

    const end = findHtmlTagEnd(source, nameStart + name.length);
    return end < 0 ? null : { start: candidate, end: end + 1 };
  }
  return null;
}

function readHtmlAttribute(tag, wantedName, elementName = 'script') {
  let index = 1 + String(elementName || '').length;
  const normalizedWantedName = String(wantedName || '').toLowerCase();
  while (index < tag.length) {
    while (index < tag.length && isHtmlSpace(tag[index])) index += 1;
    if (tag[index] === '>' || tag[index] === '/' || index >= tag.length) break;

    const nameStart = index;
    while (index < tag.length && !isHtmlSpace(tag[index]) && tag[index] !== '=' && tag[index] !== '>') index += 1;
    const name = tag.slice(nameStart, index).toLowerCase();

    while (index < tag.length && isHtmlSpace(tag[index])) index += 1;
    if (tag[index] !== '=') continue;
    index += 1;
    while (index < tag.length && isHtmlSpace(tag[index])) index += 1;

    const quote = tag[index] === '"' || tag[index] === "'" ? tag[index++] : '';
    const valueStart = index;
    if (quote) {
      while (index < tag.length && tag[index] !== quote) index += 1;
    } else {
      while (index < tag.length && !isHtmlSpace(tag[index]) && tag[index] !== '>') index += 1;
    }
    if (name === normalizedWantedName) return decodeHtmlEntities(tag.slice(valueStart, index));
    if (quote && tag[index] === quote) index += 1;
  }
  return '';
}

const RAW_TEXT_TAGS = new Set(['iframe', 'noembed', 'noframes', 'plaintext', 'style', 'textarea', 'title', 'xmp']);
const HTML_VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const SVG_HTML_INTEGRATION_POINTS = new Set(['desc', 'foreignobject', 'title']);
const MATHML_HTML_INTEGRATION_POINTS = new Set(['mi', 'mo', 'mn', 'ms', 'mtext']);

function isSelfClosingTag(tag) {
  let index = tag.length - 2;
  while (index >= 0 && isHtmlSpace(tag[index])) index -= 1;
  return tag[index] === '/';
}

function elementContext(tagName, tag, openElements) {
  const parentNamespace = openElements.at(-1)?.childNamespace || 'html';
  const namespace = parentNamespace === 'html'
    ? (tagName === 'svg' ? 'svg' : tagName === 'math' ? 'math' : 'html')
    : parentNamespace;
  const childNamespace = (namespace === 'svg' && SVG_HTML_INTEGRATION_POINTS.has(tagName))
    || (namespace === 'math' && MATHML_HTML_INTEGRATION_POINTS.has(tagName))
    || (namespace === 'math'
      && tagName === 'annotation-xml'
      && readHtmlAttribute(tag, 'encoding', tagName).toLowerCase() === 'text/html')
    ? 'html'
    : namespace;
  return { tagName, namespace, childNamespace };
}

function closeElement(openElements, tagName) {
  for (let index = openElements.length - 1; index >= 0; index -= 1) {
    if (openElements[index].tagName !== tagName) continue;
    openElements.length = index;
    return;
  }
}

function* scriptOpeningTags(source) {
  let searchStart = 0;
  const openElements = [];
  while (searchStart < source.length) {
    const start = source.indexOf('<', searchStart);
    if (start < 0) return;

    if (source.startsWith('<!--', start)) {
      const commentEnd = source.indexOf('-->', start + 4);
      searchStart = commentEnd < 0 ? source.length : commentEnd + 3;
      continue;
    }

    if (source.startsWith('<![CDATA[', start)) {
      const cdataEnd = source.indexOf(']]>', start + 9);
      searchStart = cdataEnd < 0 ? source.length : cdataEnd + 3;
      continue;
    }

    const marker = source[start + 1];
    if (marker === '/') {
      const tagName = readHtmlTagName(source, start + 2);
      const end = findHtmlTagEnd(source, start + 1);
      if (end < 0) return;
      if (tagName) closeElement(openElements, tagName);
      searchStart = end + 1;
      continue;
    }

    if (marker === '!' || marker === '?') {
      const end = findHtmlTagEnd(source, start + 1);
      if (end < 0) return;
      searchStart = end + 1;
      continue;
    }

    const tagName = readHtmlTagName(source, start + 1);
    if (!tagName) {
      searchStart = start + 1;
      continue;
    }

    const end = findHtmlTagEnd(source, start + 1);
    if (end < 0) return;

    if (tagName === 'script') {
      const context = elementContext(tagName, source.slice(start, end + 1), openElements);
      const selfClosing = isSelfClosingTag(source.slice(start, end + 1));
      if (context.namespace !== 'html' && selfClosing) {
        searchStart = end + 1;
        continue;
      }

      const closing = findHtmlClosingTag(source, end + 1, 'script');
      if (!openElements.some(({ tagName: openTagName }) => openTagName === 'template')) {
        yield {
          tag: source.slice(start, end + 1),
          end: end + 1,
          contentEnd: closing?.start ?? -1,
        };
      }
      searchStart = closing?.end ?? source.length;
      continue;
    }

    if (RAW_TEXT_TAGS.has(tagName)) {
      const closing = findHtmlClosingTag(source, end + 1, tagName);
      searchStart = closing?.end ?? source.length;
      continue;
    }

    const tag = source.slice(start, end + 1);
    const context = elementContext(tagName, tag, openElements);
    const selfClosing = isSelfClosingTag(tag);
    const shouldPush = context.namespace === 'html'
      ? !HTML_VOID_TAGS.has(tagName)
      : !selfClosing;
    if (shouldPush) openElements.push(context);
    searchStart = end + 1;
  }
}

/**
 * Yield only JSON-LD script bodies without building a DOM for the whole page.
 * Yousty profile pages contain a large application shell; parsing that shell
 * with JSDOM once for the JSON-LD and again for the noscript body made the
 * Galenica loop's peak heap grow with every unusually large profile.
 */
function* jsonLdScriptBodies(html = '') {
  const source = String(html || '');
  for (const opening of scriptOpeningTags(source)) {
    if (opening.contentEnd < 0) return;
    const tag = opening.tag;
    const type = normalizeSpace(readHtmlAttribute(tag, 'type')).toLowerCase();
    if (type !== 'application/ld+json') continue;

    yield source.slice(opening.end, opening.contentEnd);
  }
}

function extractDirectApplyUrl(html) {
  for (const scriptText of jsonLdScriptBodies(html)) {
    let jsonLd;
    try { jsonLd = JSON.parse(String(scriptText || '').trim()); } catch { continue; }

    const posting = flattenJsonLd(jsonLd).find((entry) => isJobPosting(entry) && entry.directApply === true);
    if (!posting) continue;

    const applyUrl = String(posting.url || '').trim();
    if (applyUrl) return applyUrl;
  }

  return '';
}

/**
 * The Solique profilelink sometimes carries Yousty's application widget UUID.
 * That explicit source marker makes the profile URL an application entrypoint;
 * a bare profile URL remains content-only and must not become an apply link.
 */
export function extractYoustyWidgetApplicationUrl(profileUrl = '') {
  try {
    const url = new URL(String(profileUrl || '').trim());
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || hostname !== 'www.yousty.ch') {
      return '';
    }
    if (!YOUSTY_PROFILE_PATH_RE.test(url.pathname)) return '';
    const widgetId = String(url.searchParams.get('widget') || '').trim();
    if (!YOUSTY_WIDGET_ID_RE.test(widgetId)) return '';
    return url.href;
  } catch {
    return '';
  }
}

export function parseYoustyApprenticeshipHtml(html, profileUrl = '') {
  const rawHtml = String(html || '');
  const applyUrl = extractDirectApplyUrl(rawHtml) || extractYoustyWidgetApplicationUrl(profileUrl);
  let noscriptHtml = '';
  for (const match of rawHtml.matchAll(/<noscript[^>]*>([\s\S]*?)<\/noscript>/gi)) {
    const candidate = String(match[1] || '').trim();
    if (/lehrstellenbeschreibung|descrizione|description du poste|description de l|dein arbeitsort/i.test(candidate)) {
      noscriptHtml = candidate;
      break;
    }
  }

  if (!noscriptHtml) {
    return { description: '', applyUrl, locationCandidates: [] };
  }

  const body = JSDOM.fragment(noscriptHtml);

  const descriptionHeading = Array.from(body.querySelectorAll('h2')).find((heading) =>
    /(lehrstellenbeschreibung|descrizione|description|description du poste)/i.test(
      normalizeSpace(heading.textContent || '')
    )
  );

  let description = '';
  if (descriptionHeading) {
    const chunks = [];
    let current = descriptionHeading.nextElementSibling;
    while (current && String(current.tagName || '').toLowerCase() !== 'h2') {
      const chunk = htmlToTextBlock(current);
      if (chunk) chunks.push(chunk);
      current = current.nextElementSibling;
    }
    description = chunks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  const workplaceHeading = Array.from(body.querySelectorAll('h2')).find((heading) =>
    /(arbeitsort|lieu de travail|place de travail|luogo di lavoro|posto di lavoro)/i.test(
      normalizeSpace(heading.textContent || '')
    )
  );
  let workplace = '';
  if (workplaceHeading) {
    let current = workplaceHeading.nextElementSibling;
    while (current && String(current.tagName || '').toLowerCase() !== 'h2') {
      const value = normalizeSpace(current.textContent || '');
      if (value) {
        workplace = value;
        break;
      }
      current = current.nextElementSibling;
    }
  }

  // Yousty removed JobPosting JSON-LD from apprenticeship details in November
  // 2026, but still renders the vacancy-specific Swiss address below its
  // localized workplace heading. Keep this source-native boundary: a random
  // postal-looking string elsewhere in the application shell is not evidence.
  const address = /^(?:(.+?),\s*)?(\d{4})\s+(.+)$/.exec(workplace);
  const locationCandidates = address
    ? [{
      location: `${address[2]} ${address[3]}`,
      addressLocality: address[3],
      addressCountry: 'CH',
      postalCode: address[2],
      ...(address[1] ? { streetAddress: address[1] } : {}),
    }]
    : [];

  return {
    description,
    applyUrl,
    locationCandidates,
  };
}
