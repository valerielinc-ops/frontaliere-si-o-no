/**
 * Axpo Job Parser — converts Teamtailor RSS HTML to structured markdown.
 *
 * Axpo RSS descriptions are entity-encoded HTML (`&lt;p&gt;` instead of `<p>`).
 * This module decodes entities, then converts the HTML to clean markdown
 * with proper headings, bullet lists, and paragraph structure.
 */

import { JSDOM } from 'jsdom';

// ──────────────────────────────────────────────────────────────
// Entity decoding
// ──────────────────────────────────────────────────────────────

/** Decode HTML entities to real characters. */
export function decodeEntities(text = '') {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, '\u00A0');
}

// ──────────────────────────────────────────────────────────────
// HTML → Markdown converter for Teamtailor content
// ──────────────────────────────────────────────────────────────

/**
 * Convert Teamtailor HTML to structured markdown.
 *
 * Handles:
 * - <h1>–<h4> → ## heading
 * - <ul>/<ol>/<li> → - bullet / 1. numbered
 * - <p> with leading · → - bullet
 * - <strong>/<b> → **bold**
 * - <em>/<i> → *italic*
 * - <hr> → ---
 * - <figure>/<lite-youtube> → stripped
 * - <span> → pass-through
 *
 * Returns { markdown, sourceTextLength, headingCount, bulletCount }
 */
export function htmlToMarkdown(html = '') {
  if (!html || !html.trim()) return { markdown: '', sourceTextLength: 0, headingCount: 0, bulletCount: 0 };

  // Decode entities if the input is entity-encoded
  const decoded = html.includes('&lt;') ? decodeEntities(html) : html;

  // Parse with JSDOM
  const dom = new JSDOM(`<body>${decoded}</body>`);
  const body = dom.window.document.body;

  // Remove unwanted elements
  for (const el of body.querySelectorAll('figure, lite-youtube, script, style, noscript')) {
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
    if (node.nodeType === 3) {
      return node.textContent.replace(/\u00A0/g, ' ');
    }
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
    return children;
  }

  function processNode(node, depth = 0) {
    if (node.nodeType === 3) {
      const text = node.textContent.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) lines.push(text);
      return;
    }
    if (node.nodeType !== 1) return;

    const tag = node.tagName.toLowerCase();

    // Skip removed elements
    if (['figure', 'lite-youtube', 'script', 'style', 'noscript'].includes(tag)) return;

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
          const liContent = processListItem(child, tag === 'ol' ? idx : 0, depth);
          if (liContent) {
            lines.push(liContent);
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

      // Detect pseudo-bullet paragraphs (Teamtailor uses · as bullet in some jobs)
      if (/^[·•●▪]\s*/.test(text)) {
        const bulletText = text.replace(/^[·•●▪]\s*/, '').trim();
        if (bulletText) {
          lines.push(`- ${bulletText}`);
          bulletCount++;
        }
        return;
      }

      // Check if the paragraph is essentially a heading (all bold, short)
      const boldContent = Array.from(node.querySelectorAll('strong, b'))
        .map((el) => getTextContent(el))
        .join(' ')
        .trim();
      const fullText = getTextContent(node);
      if (
        boldContent &&
        fullText &&
        boldContent === fullText &&
        fullText.length < 80 &&
        !fullText.includes('·')
      ) {
        headingCount++;
        lines.push('', `## ${fullText}`, '');
        return;
      }

      lines.push('', text, '');
      return;
    }

    // Span, strong outside of p, etc. — recurse
    for (const child of node.childNodes) {
      processNode(child, depth);
    }
  }

  function processListItem(li, orderedIdx, depth) {
    const prefix = depth > 0 ? '  ' : '';
    const bullet = orderedIdx > 0 ? `${orderedIdx}.` : '-';

    // Check for nested lists
    const nestedList = li.querySelector('ul, ol');
    if (nestedList) {
      // Get direct text before nested list
      const directText = [];
      for (const child of li.childNodes) {
        if (child.nodeType === 1 && (child.tagName.toLowerCase() === 'ul' || child.tagName.toLowerCase() === 'ol')) break;
        const t = processInline(child).replace(/\s+/g, ' ').trim();
        if (t) directText.push(t);
      }
      const mainLine = directText.join(' ').trim();
      const subLines = [];
      for (const subLi of nestedList.querySelectorAll(':scope > li')) {
        const subText = processInline(subLi).replace(/\s+/g, ' ').trim();
        if (subText) {
          subLines.push(`  - ${subText}`);
          bulletCount++;
        }
      }
      const result = mainLine ? `${prefix}${bullet} ${mainLine}` : '';
      return [result, ...subLines].filter(Boolean).join('\n');
    }

    const text = processInline(li).replace(/\s+/g, ' ').trim();
    return text ? `${prefix}${bullet} ${text}` : '';
  }

  for (const child of body.childNodes) {
    processNode(child);
  }

  // Normalize output
  let markdown = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { markdown, sourceTextLength, headingCount, bulletCount };
}

// ──────────────────────────────────────────────────────────────
// Quality validation
// ──────────────────────────────────────────────────────────────

/**
 * Validate an Axpo job description.
 * @param {{ markdown: string, sourceTextLength: number, headingCount: number, bulletCount: number }} detail
 * @param {number} minChars Minimum chars for the markdown
 * @param {number} minSourceRatio Minimum ratio markdown/source
 * @returns {{ ok: boolean, warnings: string[] }}
 */
export function validateAxpoDescription(detail, minChars = 400, minSourceRatio = 0.2) {
  const warnings = [];
  const { markdown, sourceTextLength, headingCount } = detail;
  const len = (markdown || '').length;

  if (len < minChars) {
    warnings.push(`Description too short: ${len} chars (min ${minChars})`);
  }

  if (sourceTextLength > 200 && len / sourceTextLength < minSourceRatio) {
    warnings.push(
      `Description ratio too low: ${len}/${sourceTextLength} = ${(len / sourceTextLength).toFixed(2)} (min ${minSourceRatio})`
    );
  }

  if (sourceTextLength > 500 && headingCount < 1) {
    warnings.push(`No section headings found in description (source ${sourceTextLength} chars)`);
  }

  return { ok: warnings.length === 0, warnings };
}
