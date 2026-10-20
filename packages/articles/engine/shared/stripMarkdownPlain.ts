/**
 * stripMarkdownPlain — single source of truth for flattening AI-generated
 * article body markdown (bold/italic/links/headings/lists/code/newlines)
 * into plain text for FAQPage JSON-LD `acceptedAnswer.text` and other
 * plain-text surfaces derived from the same article body corpus.
 *
 * Bold/italic delimiters must not cross a newline — a negated character
 * class like `[^*]` implicitly includes `\n`, so a stray unpaired `*`
 * (e.g. a `* ` list bullet marker) can pair with an unrelated `*` many
 * lines later and swallow an entire paragraph into a bogus emphasis span.
 *
 * This file exists because the same logic had drifted into two
 * near-identical copies (BlogArticles.stripMarkdown, ogPagesPlugin's
 * stripMarkdownForFaq) that both operate on the same AI-generated article
 * body text — a fix applied to one without the other leaves the drifted
 * copy free to keep corrupting FAQPage structured data. Pure, zero-import,
 * safe to share between React components and build plugins.
 */
export function stripMarkdownPlain(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{2,}/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const EXCERPT_LABEL_RE = /^\s*(?:In breve|In short|Kurz gesagt|En bref)\s*(?::|[-–—])?\s*/i;
const EXCERPT_TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const EXCERPT_TABLE_ROW_RE = /^\s*\|[^|]+(?:\|[^|]+)+\|?\s*$/;

/**
 * Flatten a translated article excerpt before it reaches a card or JSON-LD.
 *
 * Excerpts are supposed to be plain text, but this remains a last-mile guard
 * for stale corpus values, runtime overlays and translations arriving before
 * a corpus repair. Table rows need a small pre-pass because the general body
 * flattener intentionally preserves pipe prose.
 */
export function normalizeArticleExcerptPlain(text: string): string {
  const tableSafe = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !EXCERPT_TABLE_SEPARATOR_RE.test(line))
    .map((line) => {
      if (!EXCERPT_TABLE_ROW_RE.test(line)) return line;
      return line
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .replace(/\s*\|\s*/g, ' ');
    })
    .join('\n');

  return stripMarkdownPlain(tableSafe).replace(EXCERPT_LABEL_RE, '').trim();
}
