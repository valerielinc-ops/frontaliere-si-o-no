import { flatString } from './flat-string.mjs';

const ALTERNATE_LINK_RE = /<link\s+rel=["']?alternate["']?[^>]*hreflang=["']?([^"'\s>]+)["']?[^>]*href=["']?([^"'\s>]+)["']?/gi;

/** Extract the locale-to-href map without retaining the source HTML head. */
export function extractHreflangAlternates(html) {
  const alternates = new Map();
  ALTERNATE_LINK_RE.lastIndex = 0;
  let match;
  while ((match = ALTERNATE_LINK_RE.exec(html)) !== null) {
    // Regex captures are V8 SlicedStrings; a retained href must not pin its
    // whole source document in an audit-wide map (see flat-string.mjs).
    alternates.set(flatString(match[1]), flatString(match[2]));
  }
  return alternates;
}
