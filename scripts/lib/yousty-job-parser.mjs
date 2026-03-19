import { JSDOM } from 'jsdom';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function htmlToTextBlock(element) {
  if (!element) return '';
  const parts = [];

  for (const node of Array.from(element.childNodes || [])) {
    if (node.nodeType === 3) {
      const text = normalizeSpace(node.textContent || '');
      if (text) parts.push(text);
      continue;
    }

    if (node.nodeType !== 1) continue;
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

  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function parseYoustyApprenticeshipHtml(html, profileUrl) {
  const rawHtml = String(html || '');
  const noscriptMatches = [...rawHtml.matchAll(/<noscript[^>]*>([\s\S]*?)<\/noscript>/gi)];
  const noscriptHtml = (
    noscriptMatches
      .map((match) => String(match[1] || ''))
      .find((chunk) => /lehrstellenbeschreibung|descrizione|description du poste|dein arbeitsort/i.test(chunk))
    || ''
  ).trim();

  if (!noscriptHtml) {
    return { description: '', applyUrl: normalizeSpace(profileUrl) };
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
    applyUrl: normalizeSpace(profileUrl),
  };
}
