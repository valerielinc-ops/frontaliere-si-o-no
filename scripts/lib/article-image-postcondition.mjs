const GENERIC_IMAGE_PATH = '/og-image.png';

function attrsFromTag(tag) {
  const attrs = {};
  for (const match of String(tag).matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[String(match[1]).toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  return attrs;
}
export function normalizeImagePath(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const url = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(raw, 'https://frontaliereticino.ch');
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

export function declaredImageIsOwn(value) {
  const normalized = normalizeImagePath(value);
  return Boolean(normalized && normalized.split(/[?#]/, 1)[0] !== GENERIC_IMAGE_PATH);
}

export function extractOgImage(html) {
  for (const match of String(html ?? '').matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attrsFromTag(match[0]);
    if (String(attrs.property || '').toLowerCase() === 'og:image') return attrs.content || null;
  }
  return null;
}

export function isGenericOgImage(html) {
  const normalized = normalizeImagePath(extractOgImage(html));
  return Boolean(normalized && normalized.split(/[?#]/, 1)[0] === GENERIC_IMAGE_PATH);
}

export function filterEntriesByImagePostcondition({ entries = [], declaredImages = {}, htmlByPath = {} } = {}) {
  const keptEntries = [];
  const excludedArticles = [];
  let excludedPages = 0;

  for (const entry of entries) {
    const declaredImage = declaredImages[entry.articleId] ?? declaredImages.get?.(entry.articleId) ?? null;
    const paths = [
      ...Object.values(entry.paths || {}),
      ...Object.values(entry.flatPaths || {}),
    ].filter(Boolean);
    const fallbackPaths = [...new Set(paths.filter((rel) => isGenericOgImage(htmlByPath[rel])))];
    if (!declaredImageIsOwn(declaredImage) || fallbackPaths.length === 0) {
      keptEntries.push(entry);
      continue;
    }
    excludedPages += paths.length;
    excludedArticles.push({ articleId: entry.articleId, declaredImage, fallbackPaths, paths });
  }

  return {
    entries: keptEntries,
    excludedArticles,
    excludedPages,
    firstExcludedArticleIds: excludedArticles.slice(0, 10).map((item) => item.articleId),
    firstFallbackPaths: excludedArticles.flatMap((item) => item.fallbackPaths).slice(0, 10),
  };
}
