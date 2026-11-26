import { readAttr, scanMarkupStartTags } from './html-attr.mjs';

export const GENERIC_IMAGE_PATH = '/og-image.png';
const SITE_ORIGIN = 'https://frontaliereticino.ch';
export function normalizeImagePath(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw, SITE_ORIGIN);
    if (url.origin !== SITE_ORIGIN) return null;
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
  for (const { raw } of scanMarkupStartTags(String(html ?? ''), 'meta')) {
    if (readAttr(raw, 'property').toLowerCase() === 'og:image') return readAttr(raw, 'content') || null;
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
