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
  const entries = {};
  let literalCount = 0;
  let dynamicCount = 0;
  const unsupported = [];
  for (const match of String(source ?? '').matchAll(/^[ \t]*(?:'(\/[^'\n]*)'|"(\/[^"\n]*)")\s*:\s*(?:'(\/[^'\n]*)'|"(\/[^"\n]*)"|(`)|(\S))/gm)) {
    const fromRaw = match[1] ?? match[2];
    const toRaw = match[3] ?? match[4];
    if (toRaw !== undefined) {
      const from = fromRaw.endsWith('/') ? fromRaw : `${fromRaw}/`;
      const to = toRaw.endsWith('/') ? toRaw : `${toRaw}/`;
      entries[from] = to;
      literalCount += 1;
    } else if (match[5] !== undefined) {
      dynamicCount += 1;
    } else {
      unsupported.push(fromRaw);
    }
  }
  return { entries, literalCount, dynamicCount, unsupported };
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
