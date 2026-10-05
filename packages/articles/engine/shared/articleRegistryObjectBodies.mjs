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

    // Comments are skipped whole: the registry header is prose with
    // apostrophes and backticks ("doesn't", `@/`), and reading one of those as
    // an opening quote swallowed the rest of the file into a single "string".
    if (char === '/' && source[i + 1] === '/') {
      const newline = source.indexOf('\n', i + 2);
      i = newline === -1 ? source.length : newline;
    } else if (char === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? source.length : close + 1;
    } else if (char === "'" || char === '"' || char === '`') {
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

const IDENTIFIER = /[A-Za-z_$][\w$]*/y;

/**
 * Top-level `key: 'string'` pairs of one object body returned by
 * {@link articleRegistryObjectBodies}, tokenized with the same quote rules.
 *
 * A regex over the raw body cannot tell a field from text inside another
 * field's quoted value: `title: "Promo image: 'wrong.jpg'"` would read as the
 * `image` field. Here keys are read only at the start of a top-level member,
 * and every quoted value, comment and nested `([{` is skipped as a whole, so a
 * field name inside a value is never seen as a key.
 *
 * Values are the inner text of a single- or double-quoted literal, escapes
 * kept as written (what the regex readers returned). A member whose value is
 * not a plain string literal (`true`, a call, a template, `'a' + b`) is
 * omitted. A repeated key keeps the last value, as in JavaScript.
 *
 * @param {string} body
 * @returns {Map<string, string>}
 */
export function articleRegistryObjectFields(body) {
  const fields = new Map();
  const n = body.length;
  let i = 0;

  const skipTrivia = () => {
    while (i < n) {
      if (/\s/.test(body[i])) {
        i += 1;
      } else if (body.startsWith('//', i)) {
        const newline = body.indexOf('\n', i + 2);
        i = newline === -1 ? n : newline + 1;
      } else if (body.startsWith('/*', i)) {
        const close = body.indexOf('*/', i + 2);
        i = close === -1 ? n : close + 2;
      } else {
        return;
      }
    }
  };

  /** Index just past the quoted literal opening at `start`. */
  const skipQuoted = (start) => {
    const quote = body[start];
    let j = start + 1;
    while (j < n) {
      if (body[j] === '\\') j += 2;
      else if (body[j] === quote) return j + 1;
      else j += 1;
    }
    return n;
  };

  /** Advance past the rest of the current member, including its comma. */
  const skipMember = () => {
    let depth = 0;
    while (i < n) {
      const char = body[i];
      if (char === "'" || char === '"' || char === '`') {
        i = skipQuoted(i);
      } else if (body.startsWith('//', i) || body.startsWith('/*', i)) {
        skipTrivia();
      } else if (char === '(' || char === '[' || char === '{') {
        depth += 1;
        i += 1;
      } else if ((char === ')' || char === ']' || char === '}') && depth > 0) {
        depth -= 1;
        i += 1;
      } else if (char === ',' && depth === 0) {
        i += 1;
        return;
      } else {
        i += 1;
      }
    }
  };

  while (i < n) {
    skipTrivia();
    if (i >= n) break;

    let key;
    if (body[i] === "'" || body[i] === '"') {
      const end = skipQuoted(i);
      key = body.slice(i + 1, end - 1);
      i = end;
    } else {
      IDENTIFIER.lastIndex = i;
      const match = IDENTIFIER.exec(body);
      if (!match) {
        skipMember();
        continue;
      }
      key = match[0];
      i += key.length;
    }

    skipTrivia();
    if (body[i] !== ':') {
      skipMember();
      continue;
    }
    i += 1;
    skipTrivia();

    if (body[i] === "'" || body[i] === '"') {
      const start = i;
      i = skipQuoted(start);
      const value = body.slice(start + 1, i - 1);
      skipTrivia();
      if (i >= n || body[i] === ',') {
        fields.set(key, value);
        i += 1;
        continue;
      }
    }
    // Not a plain string literal: the key's last value is not a string.
    fields.delete(key);
    skipMember();
  }

  return fields;
}
