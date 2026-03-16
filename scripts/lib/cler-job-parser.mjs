/**
 * Banca Cler job detail parser.
 * Converts rich HTML from cler.ch career pages to structured markdown.
 */
import { JSDOM } from 'jsdom';

/**
 * Convert Cler job detail HTML to structured markdown.
 * Parses `.m-richtext__content` for headings, paragraphs, and lists,
 * plus `.JobDetail__list` for metadata (department, location, workload, start date).
 */
export function htmlToMarkdown(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const parts = [];

  // 1) Extract metadata from JobDetail list
  const metaItems = doc.querySelectorAll('.JobDetail__item');
  const meta = {};
  for (const item of metaItems) {
    const slots = item.querySelectorAll('.JobDetail__item-slot');
    if (slots.length >= 2) {
      const key = slots[0].textContent.trim();
      const val = slots[1].textContent.trim();
      if (key && val) meta[key] = val;
    }
  }

  // 2) Extract richtext content
  const richtext = doc.querySelector('.m-richtext__content');
  if (!richtext) return '';

  for (const child of richtext.children) {
    const tag = child.tagName.toUpperCase();
    const text = child.textContent.trim();
    if (!text) continue;

    if (tag === 'H1') {
      parts.push(`## ${text}`);
    } else if (tag === 'H2' || tag === 'H3') {
      // Skip "Noch Fragen?" / "Des questions?" / contact sections
      if (/^noch fragen|^des questions|^domande/i.test(text)) break;
      parts.push(`### ${text}`);
    } else if (tag === 'P') {
      // Clean up excessive whitespace from CMS
      const cleaned = text.replace(/\s+/g, ' ').trim();
      if (cleaned.length > 10) parts.push(cleaned);
    } else if (tag === 'UL' || tag === 'OL') {
      const items = child.querySelectorAll('li');
      for (const li of items) {
        const liText = li.textContent.trim().replace(/\s+/g, ' ');
        if (liText) parts.push(`- ${liText}`);
      }
    }
  }

  // 3) Append metadata footer if available
  const metaLines = [];
  for (const [key, val] of Object.entries(meta)) {
    metaLines.push(`**${key}:** ${val}`);
  }
  if (metaLines.length > 0) {
    parts.push('---');
    parts.push(metaLines.join('\n'));
  }

  return parts.join('\n\n');
}

/**
 * Validate a Cler job description for quality.
 * Returns { ok: boolean, warnings: string[] }.
 */
export function validateClerDescription(description, sourceTextLength = 0) {
  const warnings = [];
  const descLen = (description || '').length;

  if (descLen < 350) {
    warnings.push(`Description too short: ${descLen} chars (min 350)`);
  }

  // Must have at least one section heading (### in markdown)
  if (!/^###\s/m.test(description || '')) {
    warnings.push('No section headings found (expected ### Dein neuer Job, ### Davon profitieren wir, etc.)');
  }

  // Must have list items (responsibilities or requirements)
  const listItems = ((description || '').match(/^- /gm) || []).length;
  if (listItems < 2) {
    warnings.push(`Too few list items: ${listItems} (expected ≥ 2)`);
  }

  // Coverage ratio check (markdown is denser than raw source text)
  if (sourceTextLength > 200 && descLen / sourceTextLength < 0.15) {
    warnings.push(`Low source coverage: ${descLen}/${sourceTextLength} = ${(descLen / sourceTextLength).toFixed(2)}`);
  }

  return { ok: warnings.length === 0, warnings };
}
