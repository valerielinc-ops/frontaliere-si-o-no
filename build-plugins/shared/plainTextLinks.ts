import { escHtml } from './htmlEscape';

/** Keep FAQ prose plain text while making its HTTP(S) sources usable. */
export function renderPlainTextLinks(value: string): string {
  const urls = /https?:\/\/[^\s<>"'\u2018\u2019\u201c\u201d]+/g;
  let cursor = 0;
  let html = '';
  for (const match of value.matchAll(urls)) {
    const start = match.index!;
    // Sentence punctuation is not part of a source URL.
    const url = match[0].replace(/[.,;:!?\)\]]+$/, '');
    html += escHtml(value.slice(cursor, start));
    html += `<a href="${escHtml(url)}" rel="noopener noreferrer">${escHtml(url)}</a>`;
    cursor = start + url.length;
  }
  return html + escHtml(value.slice(cursor));
}
