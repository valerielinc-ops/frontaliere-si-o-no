/**
 * Resolve article hrefs to the route that owns the content.
 *
 * Article pages have two deliberately different migration states:
 *
 *  - a shadowed page stays live, but its internal links should point at the
 *    winner from the canonical-override map;
 *  - a retired/renamed page is a transition bridge, so internal links should
 *    use the redirect's final target instead of advertising the bridge.
 *
 * Keep the distinction in one resolver. The renderer is shared with the
 * corpus repository, where the site-owned redirect file is normally absent;
 * an absent or malformed optional map therefore means "leave the href alone".
 */

const SITE_ORIGIN = 'https://frontaliereticino.ch';

/** @param {unknown} value */
function normalizedPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  const path = value.split(/[?#]/, 1)[0];
  if (!path || path.includes('//') || /[\u0000-\u001f\u007f\\]/.test(path)) return null;
  return path === '/' ? '/' : `${path.replace(/\/+$/, '')}/`;
}

/** @param {unknown} value */
function normalizedRouteMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [from, to] of Object.entries(value)) {
    const source = normalizedPath(from);
    const target = normalizedPath(to);
    if (source && target && source !== '/') out[source] = target;
  }
  return out;
}

/**
 * Follow the explicit redirect table to its final entry. Build-time parsers
 * reject chains, but following a bounded map here keeps a generated link safe
 * during the short window where a shard may contain an older map. Cycles are
 * left at the first repeated path rather than guessed through.
 *
 * @param {string} path
 * @param {Record<string, string>} redirects
 */
function resolveRedirectPath(path, redirects) {
  const seen = new Set();
  let current = path;
  while (redirects[current] && !seen.has(current)) {
    seen.add(current);
    current = redirects[current];
  }
  return current;
}

/**
 * Apply a slug canonical override only when the current and winner URLs share
 * the same article-section prefix. The map is keyed by localized slug, so
 * this context check prevents a coincidentally equal slug in another route
 * family from being reinterpreted as an article.
 *
 * @param {string} path
 * @param {Record<string, string>} overrides
 */
function resolveOverridePath(path, overrides) {
  const article = /^(.*\/)([^/]+)\/$/.exec(path);
  if (!article) return path;
  const winnerUrl = overrides[article[2]];
  if (typeof winnerUrl !== 'string') return path;

  let winner;
  try {
    winner = new URL(winnerUrl, SITE_ORIGIN);
  } catch {
    return path;
  }
  if (winner.origin !== SITE_ORIGIN) return path;
  const winnerPath = normalizedPath(winner.pathname);
  if (!winnerPath) return path;
  const winnerArticle = /^(.*\/)([^/]+)\/$/.exec(winnerPath);
  if (!winnerArticle || winnerArticle[1] !== article[1]) return path;
  return winnerPath;
}

/**
 * Resolve a root-relative article route. Query strings and fragments are not
 * part of route ownership, but are retained on the returned href by the URL
 * wrapper below.
 *
 * @param {string} path
 * @param {{ redirects?: Record<string, string>, canonicalOverrides?: Record<string, string> }} [maps]
 */
export function resolveArticleRoutePath(path, maps = {}) {
  const normalized = normalizedPath(path);
  if (!normalized) return path;
  const redirects = normalizedRouteMap(maps.redirects);
  const overrides = maps.canonicalOverrides && typeof maps.canonicalOverrides === 'object'
    ? maps.canonicalOverrides
    : {};
  return resolveOverridePath(resolveRedirectPath(normalized, redirects), overrides);
}

/**
 * Resolve an internal article href while preserving its original relative or
 * absolute form. External URLs, fragment/mail links, and ordinary relative
 * references do not carry enough route context and are returned verbatim.
 *
 * @param {string} href
 * @param {{ redirects?: Record<string, string>, canonicalOverrides?: Record<string, string> }} [maps]
 */
export function resolveArticleRouteHref(href, maps = {}) {
  if (typeof href !== 'string' || !href) return href;
  const isRootRelative = href.startsWith('/');
  const isAbsolute = /^https?:\/\//i.test(href);
  if (!isRootRelative && !isAbsolute) return href;

  let url;
  try {
    url = isRootRelative ? new URL(href, SITE_ORIGIN) : new URL(href);
  } catch {
    return href;
  }
  if (url.origin !== SITE_ORIGIN) return href;

  const path = resolveArticleRoutePath(url.pathname, maps);
  if (path === normalizedPath(url.pathname)) return href;
  const suffix = `${url.search}${url.hash}`;
  return isAbsolute ? `${SITE_ORIGIN}${path}${suffix}` : `${path}${suffix}`;
}

/** @typedef {{ index: number, closed: boolean }} TriviaResult */

/**
 * Skip whitespace and comments without ever interpreting their contents as
 * source tokens. A closed flag lets callers fail closed on a truncated block
 * comment instead of silently dropping the entry that preceded it.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {TriviaResult}
 */
function skipTrivia(text, offset) {
  let index = offset;
  while (index < text.length) {
    if (/\s/u.test(text[index])) {
      index += 1;
      continue;
    }
    if (text.startsWith('//', index)) {
      const lineEnd = text.indexOf('\n', index + 2);
      index = lineEnd < 0 ? text.length : lineEnd + 1;
      continue;
    }
    if (text.startsWith('/*', index)) {
      const commentEnd = text.indexOf('*/', index + 2);
      if (commentEnd < 0) return { index: text.length, closed: false };
      index = commentEnd + 2;
      continue;
    }
    break;
  }
  return { index, closed: true };
}

/**
 * Read a single- or double-quoted JavaScript string. The raw contents are
 * retained because this parser only accepts route literals; decoding escapes
 * here would make the source scan disagree with the build validator.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {{ value: string, end: number } | null}
 */
function readQuotedLiteral(text, offset) {
  const quote = text[offset];
  if (quote !== "'" && quote !== '"') return null;
  let index = offset + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) {
      return { value: text.slice(offset + 1, index), end: index + 1 };
    }
    if (char === '\n' || char === '\r') return null;
    index += 1;
  }
  return null;
}

/**
 * Skip a template expression, including nested braces, strings, comments,
 * and nested template literals. The redirect map has one dynamic template
 * value, but its contents must never be scanned for fake map properties.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {number | null}
 */
function skipTemplateExpression(text, offset) {
  let depth = 1;
  let index = offset;
  while (index < text.length) {
    const char = text[index];
    if (char === "'" || char === '"') {
      const literal = readQuotedLiteral(text, index);
      if (!literal) return null;
      index = literal.end;
      continue;
    }
    if (char === '`') {
      const end = skipTemplateLiteral(text, index);
      if (end === null) return null;
      index = end;
      continue;
    }
    if (text.startsWith('//', index)) {
      const lineEnd = text.indexOf('\n', index + 2);
      index = lineEnd < 0 ? text.length : lineEnd + 1;
      continue;
    }
    if (text.startsWith('/*', index)) {
      const commentEnd = text.indexOf('*/', index + 2);
      if (commentEnd < 0) return null;
      index = commentEnd + 2;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return null;
}

/**
 * Skip a template literal, including `${...}` expressions.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {number | null}
 */
function skipTemplateLiteral(text, offset) {
  let index = offset + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '`') return index + 1;
    if (char === '$' && text[index + 1] === '{') {
      const expressionEnd = skipTemplateExpression(text, index + 2);
      if (expressionEnd === null) return null;
      index = expressionEnd;
      continue;
    }
    index += 1;
  }
  return null;
}

/**
 * Scan literal redirect entries from the host's legacy redirect source.
 * Unlike a line-oriented regex, this scanner advances over comments, quoted
 * strings, and template literals as lexical units. It therefore cannot treat
 * a property-shaped line in a comment/string as a redirect. Trivia after a
 * literal is consumed repeatedly, so consecutive comments before `,` or `}`
 * do not make a valid entry disappear.
 *
 * @param {string} source
 * @returns {{entries: Record<string, string>, literalCount: number, dynamicCount: number, unsupported: string[]}}
 */
export function scanRedirectSource(source) {
  const entries = {};
  let literalCount = 0;
  let dynamicCount = 0;
  const unsupported = [];
  const text = String(source ?? '');
  let index = 0;

  while (index < text.length) {
    const trivia = skipTrivia(text, index);
    if (!trivia.closed) break;
    index = trivia.index;
    if (index >= text.length) break;

    if (text[index] === '`') {
      index = skipTemplateLiteral(text, index) ?? text.length;
      continue;
    }
    if (text[index] !== "'" && text[index] !== '"') {
      index += 1;
      continue;
    }

    const keyLiteral = readQuotedLiteral(text, index);
    if (!keyLiteral) {
      index += 1;
      continue;
    }
    index = keyLiteral.end;
    if (!keyLiteral.value.startsWith('/')) continue;

    const colon = skipTrivia(text, index);
    if (!colon.closed) break;
    if (text[colon.index] !== ':') {
      index = colon.index;
      continue;
    }

    const valueStart = skipTrivia(text, colon.index + 1);
    if (!valueStart.closed) {
      unsupported.push(keyLiteral.value);
      break;
    }
    index = valueStart.index;

    if (text[index] === '`') {
      const templateEnd = skipTemplateLiteral(text, index);
      if (templateEnd === null) {
        unsupported.push(keyLiteral.value);
        break;
      }
      dynamicCount += 1;
      index = templateEnd;
      continue;
    }

    const valueLiteral = readQuotedLiteral(text, index);
    if (!valueLiteral || !valueLiteral.value.startsWith('/')) {
      unsupported.push(keyLiteral.value);
      index = valueLiteral?.end ?? index + 1;
      continue;
    }

    const tail = skipTrivia(text, valueLiteral.end);
    if (!tail.closed || (text[tail.index] !== ',' && text[tail.index] !== '}' && tail.index < text.length)) {
      unsupported.push(keyLiteral.value);
      index = valueLiteral.end;
      continue;
    }

    const from = keyLiteral.value.endsWith('/') ? keyLiteral.value : `${keyLiteral.value}/`;
    const to = valueLiteral.value.endsWith('/') ? valueLiteral.value : `${valueLiteral.value}/`;
    entries[from] = to;
    literalCount += 1;
    index = valueLiteral.end;
  }

  return { entries, literalCount, dynamicCount, unsupported };
}

/**
 * Parse literal redirect entries from the host's legacy redirect source.
 * The build-side validator uses this same parser, so route ownership cannot
 * drift because the link renderer and redirect checker scan different syntax.
 * Computed entries are reported but deliberately not guessed here.
 *
 * @param {string} source
 * @returns {{entries: Record<string, string>, literalCount: number, dynamicCount: number, unsupported: string[]}}
 */
export function parseLiteralRedirectMap(source) {
  return scanRedirectSource(source);
}

/**
 * Read the optional site-owned article redirect maps without making the
 * standalone corpus renderer depend on the site's build-plugin tree.
 * Validation and fail-closed build checks remain in shared/articleRedirects;
 * this reader supplies the same final route ownership to generated links.
 * Missing or malformed optional maps mean "leave the href alone".
 *
 * @param {{ readFileSync: typeof import('node:fs').readFileSync }} fs
 * @param {string} filePath
 * @param {string} [legacyFilePath]
 * @returns {Record<string, string>}
 */
export function loadArticleRouteRedirects(fs, filePath, legacyFilePath) {
  let data = {};
  let legacy = {};
  try {
    data = normalizedRouteMap(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch {
    // The corpus renderer normally has no site-owned data file.
  }
  if (legacyFilePath) {
    try {
      legacy = normalizedRouteMap(
        parseLiteralRedirectMap(fs.readFileSync(legacyFilePath, 'utf-8')).entries,
      );
    } catch {
      // The site build validates the source separately; keep the data map.
    }
  }
  // The legacy table wins on duplicate keys, matching legacyRedirectsPlugin.
  return normalizedRouteMap({ ...data, ...legacy });
}
