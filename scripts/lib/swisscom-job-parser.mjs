import { JSDOM } from 'jsdom';

const REQUIREMENT_SECTION_RE = /\b(cosa porti con te|what you bring|your profile|requirements?|qualifications?)\b/i;
const SECTION_TITLE_FIXES = new Map([
  ['Contettare', 'Contattare'],
]);

function normalizeSpace(value = '') {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueLines(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = normalizeSpace(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
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
  const cleaned = normalizeSpace(String(value || '').replace(/[:\-–—]+$/g, ''));
  if (!cleaned) return '';
  return SECTION_TITLE_FIXES.get(cleaned) || cleaned;
}

function isHeadingLikeElement(element, text) {
  if (!element || !text) return false;
  const tag = String(element.tagName || '').toLowerCase();
  if (/^h[1-6]$/.test(tag)) return true;
  if (!/^(p|div)$/.test(tag)) return false;
  if (text.length > 90) return false;
  if (/[.!]$/.test(text) && text.length > 55) return false;

  const formatted = element.querySelector('b, strong, u');
  return Boolean(formatted);
}

function createSection(title = '') {
  return { title: normalizeSectionTitle(title), items: [] };
}

function pushSection(sections, title) {
  const normalizedTitle = normalizeSectionTitle(title);
  if (!normalizedTitle) return sections.at(-1) || null;

  const current = sections.at(-1);
  if (current && current.title === normalizedTitle && current.items.length === 0) {
    return current;
  }

  const section = createSection(normalizedTitle);
  sections.push(section);
  return section;
}

function pushItem(section, type, text) {
  if (!section) return;
  const normalized = normalizeSpace(text);
  if (!normalized) return;

  const prev = section.items.at(-1);
  if (prev && prev.type === type && prev.text === normalized) return;
  section.items.push({ type, text: normalized });
}

function buildMarkdown(title, sections) {
  const lines = [];
  if (normalizeSpace(title)) {
    lines.push(`# ${normalizeSpace(title)}`);
  }

  for (const section of sections) {
    const items = uniqueLines(section.items.map((item) => item.text))
      .map((text) => section.items.find((item) => item.text === text))
      .filter(Boolean);
    if (!section.title && items.length === 0) continue;

    if (lines.length > 0) lines.push('');
    if (section.title) {
      lines.push(`## ${section.title}`);
    }

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

export function parseSwisscomJobDescription(html = '', title = '') {
  const sourceHtml = String(html || '').trim();
  if (!sourceHtml) {
    return {
      description: normalizeSpace(title) ? `# ${normalizeSpace(title)}` : '',
      requirements: [],
    };
  }

  const dom = new JSDOM(`<body>${sourceHtml}</body>`);
  const body = dom.window.document.body;
  const sections = [];
  const requirements = [];

  const ensureSection = () => {
    const current = sections.at(-1);
    if (current) return current;
    const fallback = createSection('');
    sections.push(fallback);
    return fallback;
  };

  for (const element of Array.from(body.children)) {
    const tag = String(element.tagName || '').toLowerCase();
    if (!tag) continue;

    if (tag === 'ul' || tag === 'ol') {
      const items = uniqueLines(
        Array.from(element.querySelectorAll('li')).map((li) => textWithBreaks(li))
      );
      if (items.length === 0) continue;

      const currentSection = ensureSection();
      for (const item of items) {
        pushItem(currentSection, 'bullet', item);
        if (REQUIREMENT_SECTION_RE.test(currentSection.title || '')) {
          requirements.push(item);
        }
      }
      continue;
    }

    const text = textWithBreaks(element);
    if (!text) continue;

    if (isHeadingLikeElement(element, text)) {
      pushSection(sections, text);
      continue;
    }

    const currentSection = ensureSection();
    for (const paragraph of text.split('\n').map((line) => normalizeSpace(line)).filter(Boolean)) {
      pushItem(currentSection, 'paragraph', paragraph);
    }
  }

  const normalizedSections = sections
    .map((section) => ({
      title: section.title,
      items: section.items.filter((item) => normalizeSpace(item.text)),
    }))
    .filter((section) => section.title || section.items.length > 0);

  return {
    description: buildMarkdown(title, normalizedSections),
    requirements: uniqueLines(requirements),
  };
}
