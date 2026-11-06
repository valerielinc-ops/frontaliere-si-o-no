/** Align the primary editorial entity with the page that actually renders it. */
export function localizeArticlePageIdentity(
  value: unknown,
  page: { sourceUrl: string; canonicalUrl: string; headline: string; description: string; locale: string },
): void {
  const withoutFragment = (url: string) => url.split('#')[0].replace(/\/+$/, '');
  const matches = (url: unknown): url is string => typeof url === 'string' &&
    [page.sourceUrl, page.canonicalUrl].some(candidate => withoutFragment(url) === withoutFragment(candidate));
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const item = node as Record<string, unknown>;
    if (Array.isArray(item['@graph'])) item['@graph'].forEach(visit);
    const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
    if (!types.some(type => typeof type === 'string' && ['Article', 'NewsArticle', 'BlogPosting'].includes(type))) return;
    const entityObject = item.mainEntityOfPage && typeof item.mainEntityOfPage === 'object' && !Array.isArray(item.mainEntityOfPage)
      ? item.mainEntityOfPage as Record<string, unknown> : undefined;
    const entity = typeof item.mainEntityOfPage === 'string' ? item.mainEntityOfPage : entityObject?.['@id'];
    if (![item.url, entity, item['@id']].some(matches)) return;
    item.url = page.canonicalUrl;
    item.headline = page.headline;
    item.description = page.description;
    item.inLanguage = page.locale;
    if (entityObject) {
      item.mainEntityOfPage = { ...entityObject, '@id': page.canonicalUrl };
    } else item.mainEntityOfPage = page.canonicalUrl;
    const id = item['@id'];
    if (matches(id)) {
      const hash = id.includes('#') ? '#' + id.split('#').slice(1).join('#') : '';
      item['@id'] = page.canonicalUrl + hash;
    }
  };
  visit(value);
}
