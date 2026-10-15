/**
 * Block-shape predicates shared by the article renderer and its offline
 * placement observer.
 *
 * Keeping these predicates outside the JSX component lets a Node audit replay
 * the same lookahead used by `renderFormattedContent` without maintaining a
 * second definition of what a table, citation or operative list is.
 */

/** Separator row of a markdown table (`|---|:--:|`). */
export const TABLE_SEPARATOR_RE = /^\|(\s*:?-{2,}:?\s*\|)+\s*$/;

/**
 * True when a block is a markdown table, using the renderer's acceptance rule
 * (header row + separator + at least one body row).
 */
export function isTableBlock(text: string): boolean {
  if (!text.includes('|')) return false;
  const tableLines = text.split('\n').filter(line => line.trim().startsWith('|'));
  const separatorIndex = tableLines.findIndex(line => TABLE_SEPARATOR_RE.test(line.trim()));
  return separatorIndex > 0 && tableLines.length > separatorIndex + 1;
}

/** Matches a `- ` or `* ` markdown list item marker at line start. */
export const LIST_ITEM_RE = /^[-*]\s+/;

/** True when every non-blank line in a block is a markdown list item. */
export function isListBlock(value: string): boolean {
  return value.split('\n').every(line => LIST_ITEM_RE.test(line.trim()) || line.trim() === '');
}

/** Matches a `1. ` / `1) ` ordered list item marker at line start. */
const ORDERED_LIST_ITEM_RE = /^\d+[.)]\s+/;

/** True when every non-blank line in a block is an ordered list item. */
export function isOrderedListBlock(value: string): boolean {
  const lines = value.split('\n').map(line => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every(line => ORDERED_LIST_ITEM_RE.test(line));
}

/**
 * True when an ad emitted immediately before this block would split a unit
 * the reader consumes as one piece: a table, citation, or operative list.
 */
export function isAdStraddleBlock(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (isTableBlock(trimmed)) return true;
  if (trimmed.startsWith('> ')) return true;
  return isListBlock(trimmed) || isOrderedListBlock(trimmed);
}
