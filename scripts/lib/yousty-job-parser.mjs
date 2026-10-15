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
  const dom = new JSDOM(`<body>${source}</body>`);
  return htmlToTextBlock(dom.window.document.body);
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

function extractDirectApplyUrl(html) {
  const document = new JSDOM(String(html || '')).window.document;
  const scripts = [...document.querySelectorAll('script[type]')]
    .filter((script) => normalizeSpace(script.getAttribute('type')).toLowerCase() === 'application/ld+json');

  for (const script of scripts) {
    let jsonLd;
    try {
      jsonLd = JSON.parse(String(script.textContent || '').trim());
    } catch {
      continue;
    }

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
  const noscriptMatches = [...rawHtml.matchAll(/<noscript[^>]*>([\s\S]*?)<\/noscript>/gi)];
  const noscriptHtml = (
    noscriptMatches
      .map((match) => String(match[1] || ''))
      .find((chunk) => /lehrstellenbeschreibung|descrizione|description du poste|description de l|dein arbeitsort/i.test(chunk))
    || ''
  ).trim();

  if (!noscriptHtml) {
    return { description: '', applyUrl };
  }

  const noscriptDom = new JSDOM(`<body>${noscriptHtml}</body>`);
  const noscriptDoc = noscriptDom.window.document;
  const body = noscriptDoc.body;

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
