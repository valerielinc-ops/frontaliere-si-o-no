/**
 * Return the object bodies in a flat article registry source.
 *
 * Braces inside quoted fields are data, not object boundaries. Tracking the
 * quote and object depth here keeps every source reader on the same grammar.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function articleRegistryObjectBodies(source) {
  const bodies = [];
  let objectStart = -1;
  let depth = 0;
  let quote;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '{') {
      if (depth === 0) objectStart = i;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        bodies.push(source.slice(objectStart + 1, i));
        objectStart = -1;
      }
    }
  }

  return bodies;
}
