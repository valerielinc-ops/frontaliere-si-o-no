/**
 * La Fonte Job Parser — converts HubSpot CMS card HTML to structured markdown.
 *
 * La Fonte careers page uses HubSpot's `pwr-simple-list-item` cards with rich
 * HTML descriptions containing <p>, <ul>/<li>, <em>, <strong>, <span> elements.
 * This module converts the card HTML to clean markdown with proper structure.
 */

import { JSDOM } from 'jsdom';

// ──────────────────────────────────────────────────────────────
// HTML → Markdown converter
// ──────────────────────────────────────────────────────────────

/**
 * Convert HubSpot card HTML to structured markdown.
 *
 * Returns { markdown, sourceTextLength, headingCount, bulletCount }
 */
export function htmlToMarkdown(html = '') {
  if (!html || !html.trim()) return { markdown: '', sourceTextLength: 0, headingCount: 0, bulletCount: 0 };

  const dom = new JSDOM(`<body>${html}</body>`);
  const body = dom.window.document.body;

  // Remove unwanted elements
  for (const el of body.querySelectorAll('script, style, noscript')) {
    el.remove();
  }

  const sourceTextLength = (body.textContent || '').replace(/\s+/g, ' ').trim().length;

  const lines = [];
  let headingCount = 0;
  let bulletCount = 0;

  function getTextContent(node) {
    return (node.textContent || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function processInline(node) {
    if (node.nodeType === 3) return node.textContent.replace(/\u00A0/g, ' ');
    if (node.nodeType !== 1) return '';

    const tag = node.tagName.toLowerCase();
    const children = Array.from(node.childNodes).map(processInline).join('');

    if (tag === 'strong' || tag === 'b') return children ? `**${children.trim()}**` : '';
    if (tag === 'em' || tag === 'i') return children ? `*${children.trim()}*` : '';
    if (tag === 'br') return '\n';
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      const text = children.trim();
      return href && text ? `[${text}](${href})` : text;
    }
    // span, etc. — pass through
    return children;
  }

  function processNode(node) {
    if (node.nodeType === 3) {
      const text = node.textContent.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) lines.push(text);
      return;
    }
    if (node.nodeType !== 1) return;

    const tag = node.tagName.toLowerCase();

    // Headings
    if (/^h[1-6]$/.test(tag)) {
      const text = getTextContent(node);
      if (text) {
        headingCount++;
        lines.push('', `## ${text}`, '');
      }
      return;
    }

    // Horizontal rule
    if (tag === 'hr') {
      lines.push('', '---', '');
      return;
    }

    // Lists
    if (tag === 'ul' || tag === 'ol') {
      lines.push('');
      let idx = 0;
      for (const child of node.children) {
        if (child.tagName.toLowerCase() === 'li') {
          idx++;
          const bullet = tag === 'ol' ? `${idx}.` : '-';
          const text = processInline(child).replace(/\s+/g, ' ').trim();
          if (text) {
            lines.push(`${bullet} ${text}`);
            bulletCount++;
          }
        }
      }
      lines.push('');
      return;
    }

    // Paragraphs
    if (tag === 'p' || tag === 'div') {
      const text = processInline(node).replace(/\s+/g, ' ').trim();
      if (!text) return;

      // Check if it's a pseudo-heading (short bold-only paragraph)
      const boldContent = Array.from(node.querySelectorAll('strong, b'))
        .map((el) => getTextContent(el))
        .join(' ')
        .trim();
      const fullText = getTextContent(node);
      if (boldContent && fullText && boldContent === fullText && fullText.length < 60) {
        headingCount++;
        lines.push('', `## ${fullText}`, '');
        return;
      }

      lines.push('', text, '');
      return;
    }

    // Recurse into other elements
    for (const child of node.childNodes) {
      processNode(child);
    }
  }

  for (const child of body.childNodes) {
    processNode(child);
  }

  const markdown = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { markdown, sourceTextLength, headingCount, bulletCount };
}

// ──────────────────────────────────────────────────────────────
// Quality validation
// ──────────────────────────────────────────────────────────────

/**
 * Validate a La Fonte job description.
 * @param {{ markdown: string, sourceTextLength: number, headingCount: number, bulletCount: number }} detail
 * @param {number} minChars
 * @param {number} minSourceRatio
 * @returns {{ ok: boolean, warnings: string[] }}
 */
export function validateLaFonteDescription(detail, minChars = 350, minSourceRatio = 0.2) {
  const warnings = [];
  const { markdown, sourceTextLength } = detail;
  const len = (markdown || '').length;

  if (len < minChars) {
    warnings.push(`Description too short: ${len} chars (min ${minChars})`);
  }

  if (sourceTextLength > 200 && len / sourceTextLength < minSourceRatio) {
    warnings.push(
      `Description ratio too low: ${len}/${sourceTextLength} = ${(len / sourceTextLength).toFixed(2)} (min ${minSourceRatio})`
    );
  }

  // Require at least 2 distinct text blocks (paragraphs, list items, or headings)
  const blockCount = (markdown.match(/\n\n/g) || []).length + 1;
  const listCount = (markdown.match(/^- /gm) || []).length;
  const totalBlocks = blockCount + listCount;
  if (totalBlocks < 2 && sourceTextLength > 200) {
    warnings.push(`Too few text blocks: ${totalBlocks} (need at least 2)`);
  }

  return { ok: warnings.length === 0, warnings };
}
