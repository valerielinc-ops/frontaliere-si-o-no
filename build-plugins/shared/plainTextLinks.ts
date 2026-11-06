import { escHtml } from './htmlEscape';

const RAW_URL_RX = /https?:\/\/[^\s<>"'\u2018\u2019\u201c\u201d]+/g;
const MARKDOWN_LINK_RX = /\[([^\]\r\n]+)\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g;

function safeMarkdownHref(value: string): string | null {
  // FAQ copy may contain external sources and root-relative site links. Keep
  // every other scheme inert so a content edit cannot introduce a javascript:
  // or protocol-relative link into the generated HTML.
  return /^(?:https?:\/\/|\/(?!\/))/i.test(value) ? value : null;
}

export interface PlainTextLinkOptions {
  resolveHref?: (href: string) => string;
}

function renderRawUrls(value: string, opts: PlainTextLinkOptions): string {
  let cursor = 0;
  let html = '';
  for (const match of value.matchAll(RAW_URL_RX)) {
    const start = match.index!;
    // Sentence punctuation is not part of a source URL.
    const url = match[0].replace(/[.,;:!?\)\]]+$/, '');
    html += escHtml(value.slice(cursor, start));
    const href = opts.resolveHref ? opts.resolveHref(url) : url;
    html += `<a href="${escHtml(href)}" rel="noopener noreferrer">${escHtml(url)}</a>`;
    cursor = start + url.length;
  }
  return html + escHtml(value.slice(cursor));
}

/** Keep FAQ prose plain text while making its HTTP(S) sources usable. */
export function renderPlainTextLinks(value: string, opts: PlainTextLinkOptions = {}): string {
  let cursor = 0;
  let html = '';
  for (const match of value.matchAll(MARKDOWN_LINK_RX)) {
    const start = match.index!;
    html += renderRawUrls(value.slice(cursor, start), opts);
    const label = match[1];
    const href = safeMarkdownHref(match[2]);
    const resolvedHref = href && opts.resolveHref ? opts.resolveHref(href) : href;
    html += resolvedHref
      ? `<a href="${escHtml(resolvedHref)}" rel="noopener noreferrer">${escHtml(label)}</a>`
      : escHtml(label);
    cursor = start + match[0].length;
  }
  return html + renderRawUrls(value.slice(cursor), opts);
}
