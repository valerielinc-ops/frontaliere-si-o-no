/**
 * publisherMarkdown — minimal, dependency-free renderer for the markdown
 * subset publishers can use in SPONSORED ad descriptions.
 *
 * Supported syntax (deliberately tiny — this is an authoring aid, not a CMS):
 *   ## Heading      → <h2>
 *   ### Heading     → <h3>
 *   - item / * item → <ul><li>
 *   **bold**        → <strong>
 *   blank line      → paragraph break
 *
 * Safety: the input is HTML-escaped FIRST, then the markdown transforms run on
 * the escaped text — markup injection is impossible by construction (no
 * sanitizer needed, nothing to keep in sync with an allowlist).
 *
 * Shared by:
 *   - build-plugins/publisherAdPagesPlugin.ts (static /lavoro/<slug>/ pages)
 *   - components/pages/PublisherPublishPage.tsx (live editor preview)
 * so the preview the publisher sees is byte-identical to the emitted page body.
 */

export interface PublisherMarkdownClasses {
  h2?: string;
  h3?: string;
  p?: string;
  ul?: string;
  li?: string;
}

const DEFAULT_CLASSES: Required<PublisherMarkdownClasses> = {
  h2: 'text-lg font-bold text-strong mt-6 mb-2',
  h3: 'text-base font-semibold text-strong mt-4 mb-1.5',
  p: 'my-2 leading-relaxed',
  ul: 'my-2 ml-5 list-disc space-y-1',
  li: '',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

/** `**bold**` → <strong> on already-escaped text. */
function inlineMd(escaped: string): string {
  return escaped.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

const attr = (cls: string): string => (cls ? ` class="${cls}"` : '');

/**
 * Render the publisher markdown subset to HTML. Returns '' for empty input.
 * Class names are injectable so the static page and the SPA preview can apply
 * their own (Tailwind) styling while sharing the exact same structure.
 */
export function renderPublisherMarkdown(
  md: string,
  classes: PublisherMarkdownClasses = {},
): string {
  const cls = { ...DEFAULT_CLASSES, ...classes };
  const text = String(md || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';

  const out: string[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p${attr(cls.p)}>${paragraph.join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listItems.length) return;
    out.push(`<ul${attr(cls.ul)}>${listItems.map((li) => `<li${attr(cls.li)}>${li}</li>`).join('')}</ul>`);
    listItems = [];
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const h3 = line.match(/^###\s+(.+)$/);
    const h2 = !h3 && line.match(/^##\s+(.+)$/);
    const bullet = !h3 && !h2 && line.match(/^[-*•]\s+(.+)$/);
    if (h3 || h2) {
      flushParagraph();
      flushList();
      const m = (h3 || h2) as RegExpMatchArray;
      const content = inlineMd(escapeHtml(m[1].trim()));
      out.push(h3 ? `<h3${attr(cls.h3)}>${content}</h3>` : `<h2${attr(cls.h2)}>${content}</h2>`);
    } else if (bullet) {
      flushParagraph();
      listItems.push(inlineMd(escapeHtml(bullet[1].trim())));
    } else {
      flushList();
      paragraph.push(inlineMd(escapeHtml(line)));
    }
  }
  flushParagraph();
  flushList();
  return out.join('');
}

/**
 * Strip the markdown syntax, returning plain text (paragraph breaks preserved).
 * This is what gets stored in the flat `description` field — JSON-LD, meta
 * descriptions, search haystacks and the newsletter all keep consuming plain
 * text, untouched by the sponsored formatting feature.
 */
export function stripPublisherMarkdown(md: string): string {
  return String(md || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line
      .replace(/^#{2,3}\s+/, '')
      .replace(/^[-*•]\s+/, '- ')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
