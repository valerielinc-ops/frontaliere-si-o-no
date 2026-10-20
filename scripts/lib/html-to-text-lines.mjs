/**
 * Plain text for a job-posting HTML fragment that KEEPS its structure: one
 * line per paragraph/heading, list items as line-start `• ` bullets.
 *
 * Several custom hospital parsers used to run `normalizeSpace(htmlToText(…))`
 * on the posting body, which collapses every newline `htmlToText` produced —
 * sections and bullet lists ended up as one flat paragraph. This helper is
 * the line-preserving counterpart they share instead of each keeping its own
 * copy of the same tidy-up chain.
 *
 * HTML source whitespace (indentation, a sentence wrapped over two source
 * lines inside one `<p>`) carries no meaning, so it is collapsed BEFORE the
 * block tags are turned into line breaks.
 */
import { htmlToText, normalizeSpace } from './hospital-custom-html-helpers.mjs';

export function htmlToTextLines(html = '') {
  return htmlToText(String(html || '').replace(/\s+/g, ' '))
    .split('\n')
    .map((line) => normalizeSpace(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    // `</li>` and the next `<li>` each emit a newline: keep list items on
    // consecutive lines instead of separating them with a blank one.
    .replace(/\n\n(?=• )/g, '\n')
    .trim();
}
