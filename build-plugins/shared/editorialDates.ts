/** Use editorial metadata, never the build clock, for a visible revision date. */
export function editorialModifiedDate(serialized: string | undefined, separator: string): string | undefined {
  const read = (node: unknown): string | undefined => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.map(read).find(Boolean);
    const item = node as Record<string, unknown>;
    if (Array.isArray(item['@graph'])) return read(item['@graph']);
    const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
    if (!types.some(type => ['Article', 'NewsArticle', 'BlogPosting'].includes(String(type)))) return;
    const date = item.dateModified;
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(date) && Number.isFinite(Date.parse(date))) return date;
  };
  for (const part of (serialized ?? '').split(separator)) {
    try {
      const date = read(JSON.parse(part));
      if (date) return date;
    } catch { /* Malformed schema must not create a fabricated freshness signal. */ }
  }
  return undefined;
}

/**
 * Align seeded sitemap freshness with the editorial date exposed by the page.
 *
 * A sitemap `<lastmod>` is useful only when it describes the document at the
 * matching `<loc>`.  Keep entries without an editorial date untouched: a
 * missing source date is not evidence of a new build and must never turn into
 * a fabricated freshness signal.
 */
export function synchronizeSitemapLastmods(
  xml: string,
  dateForLoc: (loc: string) => string | undefined,
): string {
  return xml.replace(/<url>[\s\S]*?<\/url>/g, (block) => {
    const loc = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/)?.[1];
    if (!loc) return block;
    const date = dateForLoc(loc)?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (!date) return block;
    if (/<lastmod>/.test(block)) {
      return block.replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${date}</lastmod>`);
    }
    return block.replace(/(\s*<\/url>)/, `\n    <lastmod>${date}</lastmod>$1`);
  });
}
