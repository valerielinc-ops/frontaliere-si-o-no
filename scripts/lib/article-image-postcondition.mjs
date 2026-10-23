export const GENERIC_IMAGE_PATH = '/og-image.png';

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

/**
 * Restore the editorial hero path after a sparse CI checkout.
 *
 * The article renderer normally verifies the local hero file before emitting
 * it. Corpus rerenders intentionally use a sparse checkout without
 * `public/images/`, so a metadata-only rerender would otherwise replace every
 * existing hero with `/og-image.png` and the postcondition would (correctly)
 * refuse to publish it. The declared registry image is already the live
 * article contract; replacing only the renderer's generic fallback preserves
 * the current shard page and lets the X-card/head update travel without
 * degrading its hero image.
 */
export function restoreDeclaredImageRefs(html, declaredImage) {
  const raw = String(declaredImage ?? '').trim();
  // The corpus registry stores site-relative `/images/...` paths. Do not turn
  // an arbitrary external URL into a same-origin replacement merely because
  // URL normalization happens to leave its pathname under `/images/`.
  if (/^https?:\/\//i.test(raw)) return html;
  const image = normalizeImagePath(declaredImage);
  if (!image || !image.startsWith('/images/') || !declaredImageIsOwn(image)) return html;
  return String(html ?? '').replace(
    /(?:https?:\/\/[^"'<>\s]+)?\/og-image\.png(?:[?#][^"'<>\s]*)?/gi,
    image,
  );
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
