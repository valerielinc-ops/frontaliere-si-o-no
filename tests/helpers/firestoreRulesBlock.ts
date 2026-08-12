/**
 * The body of a `match <header> { … }` block, brace-matched.
 *
 * This replaces an `indexOf('}', start + 80)` slice that did not do what it
 * read as doing. Eighty characters past `match /newsletter_subscribers/{email}`
 * lands inside a comment, and the next `}` from there is the one in the
 * `{eventId}` placeholder of the nested `match /events/{eventId}` header — so
 * the slice that claimed to be "the subscriber document block" actually stopped
 * at the first nested match, and every nested rule was invisible to it. A brace
 * counter cannot drift that way, and nesting is exactly what these assertions
 * are about.
 */
export function matchBlock(source: string, header: string): string {
  const at = source.indexOf(header);
  if (at === -1) throw new Error(`missing rule block: ${header}`);
  const open = source.indexOf('{', at + header.length - 1);
  if (open === -1) throw new Error(`no opening brace after: ${header}`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after: ${header}`);
}
