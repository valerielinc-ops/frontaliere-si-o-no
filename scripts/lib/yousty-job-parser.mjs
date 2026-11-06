import { JSDOM } from 'jsdom';

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

const SCRIPT_OPEN_START_RE = /<script\b/gi;
const SCRIPT_CLOSE_RE = /<\/script\s*>/gi;

function isHtmlSpace(character) {
  return character === ' ' || character === '\t' || character === '\n' || character === '\f' || character === '\r';
}

function readHtmlAttribute(tag, wantedName) {
  let index = '<script'.length;
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
    if (name === wantedName) return tag.slice(valueStart, index);
    if (quote && tag[index] === quote) index += 1;
  }
  return '';
}

function* scriptOpeningTags(source) {
  for (const opening of source.matchAll(SCRIPT_OPEN_START_RE)) {
    const start = Number(opening.index || 0);
    let quote = '';
    for (let index = start + String(opening[0] || '').length; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === '>') {
        yield { tag: source.slice(start, index + 1), end: index + 1 };
        break;
      }
    }
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
    const tag = opening.tag;
    const type = normalizeSpace(readHtmlAttribute(tag, 'type')).toLowerCase();
    if (type !== 'application/ld+json') continue;

    const contentStart = opening.end;
    SCRIPT_CLOSE_RE.lastIndex = contentStart;
    const closing = SCRIPT_CLOSE_RE.exec(source);
    if (!closing) return;
    yield source.slice(contentStart, closing.index);
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
    return { description: '', applyUrl };
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

  return {
    description,
    applyUrl,
  };
}
