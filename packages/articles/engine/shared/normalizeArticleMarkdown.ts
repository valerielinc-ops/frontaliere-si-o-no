/**
 * Recover block structure from article markdown whose line breaks were
 * flattened by the translation/corpus pipeline.
 *
 * A valid heading is line-oriented (`## Heading`). Some published body fields
 * instead contain several headings on one line (`## Intro ... ## Facts ...`).
 * Keeping that text as-is turns the whole section into one TOC label and, in
 * the static renderer, one oversized heading. This repair is deliberately
 * conservative: ordinary lines are left alone, while heading markers found
 * inside a line are promoted to block boundaries and an oversized recovered
 * heading gives its trailing text back to the paragraph body.
 */

const RECOVERED_HEADING_MAX_CHARS = 120;
const RECOVERED_HEADING_TITLE_MAX_CHARS = 96;

const INLINE_HEADING_RE = /(^|\s)(#{2,6})(?=\s+)/g;
// These are sentence/discourse leads seen after a flattened title in the
// translated corpus. Restricting the match to them avoids treating a proper
// name or a German capitalized noun in an otherwise valid long heading as the
// start of a paragraph.
const HEADING_BODY_START_RE = /\s+(?=(?:For|The|This|These|In|On|According|After|During|When|Passengers|All|Per|Il|La|Le|Nel|Nella|Dopo|Secondo|Inoltre|Für|Bei|Nach|Während|Wenn|Zusätzlich|Selon|Pour|Les|Après|Lorsque|Tous)\s+[\p{L}'’-]+\s+[\p{Ll}][\p{L}'’-]*)/gu;

function listifyInlineDashes(value: string): string {
 const matches = value.match(/\s+-\s+/g) ?? [];
 return matches.length >= 1 ? `- ${value.replace(/\s+-\s+/g, '\n- ')}` : value;
}

function recoverHeadingContent(content: string): string {
 const trimmed = content.trim();
 if (!trimmed) return '';

 // Summary/facts blocks commonly use spaced dashes as their only separator:
 // `## In short - point one - point two`. Keep the label and turn the rest
 // into a readable list instead of making every point part of the heading.
 const dash = trimmed.search(/\s+-\s+/);
 if (dash > 2 && dash <= RECOVERED_HEADING_TITLE_MAX_CHARS) {
  const title = trimmed.slice(0, dash).trim();
  const body = listifyInlineDashes(trimmed.slice(dash).replace(/^\s+-\s+/, '').trim());
  return body ? `${title}\n\n${body}` : title;
 }

 // When the separator was lost completely, the first sentence often starts
 // with a capitalized word followed by lowercase prose (`## Details The ...`).
 // The short prefix is the original heading; the rest belongs to the body.
 const bodyStarts = [...trimmed.matchAll(HEADING_BODY_START_RE)];
 const bodyStartMatch = bodyStarts.find((match) => {
  const index = match.index ?? -1;
  if (index <= 2 || index > RECOVERED_HEADING_TITLE_MAX_CHARS) return false;
  // In colon titles, a capitalized word followed by lowercase text can be
  // part of the title (`Medical emergency: Swiss flight ...`). Prefer a
  // later sentence-like boundary such as `For passengers ...`.
  const prefix = trimmed.slice(0, index);
  return !prefix.includes(':') || index >= 35;
 });
 const bodyStart = bodyStartMatch?.index ?? -1;
 if (bodyStart > 2 && bodyStart <= RECOVERED_HEADING_TITLE_MAX_CHARS) {
  const title = trimmed.slice(0, bodyStart).trim();
  const body = trimmed.slice(bodyStart).trim();
  return body ? `${title}\n\n${body}` : title;
 }

 // Without a reliable body lead, keep a legitimate long heading intact.
 // Truncating it here would create a broken title and orphan its suffix.
 return trimmed;
}

function normalizeLine(line: string): string {
 const matches = [...line.matchAll(INLINE_HEADING_RE)];
 if (matches.length === 0) return line;

 const firstMarkerStart = (matches[0].index ?? 0) + (matches[0][1]?.length ?? 0);
 const firstMarkerEnd = firstMarkerStart + matches[0][2].length;
 const firstContentStart = firstMarkerEnd + (line.slice(firstMarkerEnd).match(/^\s+/)?.[0].length ?? 0);
 const hasInlineMarker = matches.length > 1 || firstMarkerStart !== 0;
 if (!hasInlineMarker && line.slice(firstContentStart).trim().length <= RECOVERED_HEADING_MAX_CHARS) return line;

 const blocks: string[] = [];
 let cursor = 0;
 for (let i = 0; i < matches.length; i += 1) {
  const match = matches[i];
  const markerStart = (match.index ?? 0) + (match[1]?.length ?? 0);
  const marker = match[2];
  const markerEnd = markerStart + marker.length;
  const contentStart = markerEnd + (line.slice(markerEnd).match(/^\s+/)?.[0].length ?? 0);
  const nextMarkerStart = i + 1 < matches.length
   ? (matches[i + 1].index ?? line.length) + (matches[i + 1][1]?.length ?? 0)
   : line.length;

  const prefix = line.slice(cursor, markerStart).trim();
  if (prefix) blocks.push(prefix);

  const content = line.slice(contentStart, nextMarkerStart).trim();
  const recovered = recoverHeadingContent(content);
  if (recovered) blocks.push(`${marker} ${recovered}`);
  cursor = nextMarkerStart;
 }

 const trailing = line.slice(cursor).trim();
 if (trailing) blocks.push(trailing);
 return blocks.join('\n\n');
}

/** Normalize markdown bodies before either renderer or TOC extraction sees them. */
export function normalizeArticleMarkdown(text: string): string {
 return text
  .replace(/\r\n?/g, '\n')
  .split('\n')
  .map(normalizeLine)
  .join('\n');
}
