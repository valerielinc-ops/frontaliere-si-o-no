/**
 * Serialize the job-description AST to HTML strings for the SSG build plugin
 * (`build-plugins/jobsSeoPagesPlugin.ts`). The SPA renderer consumes the same
 * AST via `components/community/JobDescriptionBlocks.tsx`.
 */

import type { Block, Inline } from './parser';
import { parseJobDescription, parseInline } from './parser';

function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineToHtml(tok: Inline): string {
  switch (tok.kind) {
    case 'strong':
      return `<strong>${esc(tok.value)}</strong>`;
    case 'em':
      return `<em>${esc(tok.value)}</em>`;
    default:
      return esc(tok.value);
  }
}

function inlinesToHtml(inlines: Inline[]): string {
  return inlines.map(inlineToHtml).join('');
}

export function blocksToHtml(blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'heading') {
      const tag = b.level === 2 ? 'h2' : 'h3';
      parts.push(`<${tag}>${inlinesToHtml(b.children)}</${tag}>`);
    } else if (b.kind === 'paragraph') {
      parts.push(`<p>${inlinesToHtml(b.children)}</p>`);
    } else {
      const tag = b.ordered ? 'ol' : 'ul';
      const items = b.items.map((i) => `<li>${inlinesToHtml(i)}</li>`).join('');
      parts.push(`<${tag}>${items}</${tag}>`);
    }
  }
  return parts.join('');
}

/** Drop-in replacement for the previous `plainTextToHtml()` helper in
 * jobsSeoPagesPlugin.ts. Passes through HTML input untouched when it
 * already contains structural tags. */
export function jobDescriptionTextToHtml(text: string): string {
  if (!text) return '';
  if (/<(p|ul|ol|li|h[1-6]|br|strong|em)\b/i.test(text)) return text;
  const blocks = parseJobDescription(text);
  return blocksToHtml(blocks);
}

/**
 * Render a single line/paragraph string to safe inline HTML — HTML-escapes
 * the text while converting `**bold**` → `<strong>` and `*em*` → `<em>`.
 * Strips literal markdown so audit:no-literal-markdown stays at 0.
 * If the input already carries structural tags, pass it through untouched.
 */
export function inlineTextToHtml(text: string): string {
  if (!text) return '';
  const s = String(text);
  if (/<(strong|em|a|span|br)\b/i.test(s)) return s;
  return inlinesToHtml(parseInline(s));
}
