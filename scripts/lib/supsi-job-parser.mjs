import { JSDOM } from 'jsdom';

const REQUIREMENT_SECTION_RE = /\b(requisiti|profilo|competenze richieste|sprachen?|sprachkenntnisse|requirements?|your profile|qualification|qualifiche)\b/i;
const LOCATION_RE = /\b(?:con sede a|sede a|site in|based in|bas[eé] [aà]|Standort(?:\s+ist)?|Arbeitsort(?:\s+ist)?)\s+([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ'(). -]{1,80})/i;
const TITLE_REF_RE = /\s*\((?:SUPSI\s*\/?\s*)?2\d_\d+\)\s*/gi;

function normalizeSpace(value = '') {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTitle(value = '') {
  return normalizeSpace(
    String(value || '')
      .replace(TITLE_REF_RE, ' ')
      .replace(/\s*-\s*SUPSI\s*$/i, ' ')
  );
}

function uniqueLines(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const line = normalizeSpace(value);
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

function textWithBreaks(node) {
  if (!node) return '';
  const clone = node.cloneNode(true);
  const doc = clone.ownerDocument || node.ownerDocument;
  if (clone.querySelectorAll) {
    clone.querySelectorAll('br').forEach((br) => br.replaceWith(doc.createTextNode('\n')));
  }
  return String(clone.textContent || '')
    .split('\n')
    .map((line) => normalizeSpace(line))
    .filter(Boolean)
    .join('\n');
}

function normalizeSectionTitle(value = '') {
  return normalizeSpace(String(value || '').replace(/[:\-–—]+$/g, ''));
}

function isHeadingLikeElement(element, text) {
  if (!element || !text) return false;
  const tag = String(element.tagName || '').toLowerCase();
  if (/^h[1-6]$/.test(tag)) return true;
  if (!/^(p|div|strong|b)$/.test(tag)) return false;
  if (text.length > 90) return false;
  if (/[.!?]$/.test(text) && text.length > 55) return false;
  return Boolean(element.querySelector?.('b, strong')) || tag === 'strong' || tag === 'b';
}

function createSection(title = '') {
  return { title: normalizeSectionTitle(title), items: [] };
}

function ensureSection(sections) {
  const current = sections.at(-1);
  if (current) return current;
  const section = createSection('');
  sections.push(section);
  return section;
}

function pushSection(sections, title = '') {
  const normalized = normalizeSectionTitle(title);
  if (!normalized) return ensureSection(sections);
  const current = sections.at(-1);
  if (current && current.title === normalized && current.items.length === 0) return current;
  const section = createSection(normalized);
  sections.push(section);
  return section;
}

function pushItem(section, type, text) {
  if (!section) return;
  const normalized = normalizeSpace(text);
  if (!normalized) return;
  const last = section.items.at(-1);
  if (last && last.type === type && last.text === normalized) return;
  section.items.push({ type, text: normalized });
}

function extractLocation(text = '') {
  const match = normalizeSpace(text).match(LOCATION_RE);
  const raw = normalizeSpace(match?.[1] || '');
  const trimmed = raw.split(/\b(?:grado di occupazione|entrata in funzione|data inizio|concorso annuale)\b/i)[0];
  return normalizeSpace(trimmed).replace(/[.,;:]+$/g, '').trim();
}

function buildMarkdown(title, sections) {
  const lines = [];
  if (title) lines.push(`# ${title}`);

  for (const section of sections) {
    const items = uniqueLines(section.items.map((item) => item.text))
      .map((text) => section.items.find((item) => item.text === text))
      .filter(Boolean);
    if (!section.title && items.length === 0) continue;
    if (lines.length > 0) lines.push('');
    if (section.title) lines.push(`## ${section.title}`);
    let previousType = '';
    for (const item of items) {
      if (item.type === 'bullet') {
        lines.push(`- ${item.text}`);
      } else {
        if (previousType === 'bullet') lines.push('');
        lines.push(item.text);
      }
      previousType = item.type;
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function parseSupsiJobDetail(html = '', fallbackTitle = '') {
  const sourceHtml = String(html || '').trim();
  const cleanFallbackTitle = cleanTitle(fallbackTitle);
  if (!sourceHtml) {
    return {
      title: cleanFallbackTitle,
      description: cleanFallbackTitle ? `# ${cleanFallbackTitle}` : '',
      requirements: [],
      location: '',
    };
  }

  const dom = new JSDOM(sourceHtml);
  const { document } = dom.window;
  document.querySelectorAll('script, style, noscript, svg').forEach((node) => node.remove());

  const title =
    cleanTitle(
      document.querySelector('[data-lfr-editable-id="articleTitle"]')?.textContent ||
      document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
      document.title ||
      fallbackTitle
    ) || cleanFallbackTitle;

  const contentRoot =
    document.querySelector('.fragment_5811 .lfr-richtext') ||
    document.querySelector('.lfr-richtext[data-lfr-editable-id="paragraphItem"]') ||
    document.querySelector('main');

  if (!contentRoot) {
    return {
      title,
      description: title ? `# ${title}` : '',
      requirements: [],
      location: '',
    };
  }

  const tempDom = new JSDOM('<body></body>');
  const tempDoc = tempDom.window.document;
  tempDoc.body.innerHTML = contentRoot.innerHTML;
  tempDoc.querySelectorAll('script, style, noscript, svg').forEach((node) => node.remove());

  const sections = [];
  const requirements = [];
  let location = '';

  for (const node of Array.from(tempDoc.body.childNodes)) {
    if (node.nodeType === tempDom.window.Node.TEXT_NODE) {
      const section = ensureSection(sections);
      for (const paragraph of String(node.textContent || '').split('\n').map(normalizeSpace).filter(Boolean)) {
        pushItem(section, 'paragraph', paragraph);
        if (!location) location = extractLocation(paragraph);
      }
      continue;
    }
    if (node.nodeType !== tempDom.window.Node.ELEMENT_NODE) continue;

    const element = node;
    const tag = String(element.tagName || '').toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      const items = uniqueLines(Array.from(element.querySelectorAll('li')).map((li) => textWithBreaks(li)));
      if (items.length === 0) continue;
      const section = ensureSection(sections);
      for (const item of items) {
        pushItem(section, 'bullet', item);
        if (!location) location = extractLocation(item);
        if (REQUIREMENT_SECTION_RE.test(section.title || '')) {
          requirements.push(item);
        }
      }
      continue;
    }

    const text = textWithBreaks(element);
    if (!text) continue;
    if (isHeadingLikeElement(element, text)) {
      if (normalizeSpace(text).toLowerCase() === normalizeSpace(title).toLowerCase()) {
        continue;
      }
      pushSection(sections, text);
      continue;
    }

    const section = ensureSection(sections);
    for (const paragraph of text.split('\n').map(normalizeSpace).filter(Boolean)) {
      pushItem(section, 'paragraph', paragraph);
      if (!location) location = extractLocation(paragraph);
      if (REQUIREMENT_SECTION_RE.test(section.title || '') && paragraph.length >= 8) {
        requirements.push(paragraph);
      }
    }
  }

  const normalizedSections = sections
    .map((section) => ({
      title: section.title,
      items: section.items.filter((item) => normalizeSpace(item.text)),
    }))
    .filter((section) => section.title || section.items.length > 0);

  return {
    title,
    description: buildMarkdown(title, normalizedSections),
    requirements: uniqueLines(requirements),
    location: normalizeSpace(location),
  };
}
