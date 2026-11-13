/** V8's maximum string length (characters); files above it are parsed item by item. */
export const DEFAULT_JSON_STRING_LIMIT: number;
/** Parse a top-level JSON array from text chunks without concatenating them. */
export function parseLargeJsonArray(chunks: Iterable<string>): unknown[];
/** Iterate a top-level JSON array while retaining only one item at a time. */
export function iterateJsonArrayFile(
  filePath: string,
  options?: { maxInlineBytes?: number; maxItemBytes?: number },
): IterableIterator<unknown>;
/**
 * Read a JSON file; past `maxInlineBytes` a top-level array (or `{ jobs: [...] }`
 * wrapper) is parsed item by item instead of failing with ERR_STRING_TOO_LONG.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readJsonFile(filePath: string, options?: { maxInlineBytes?: number }): any;
