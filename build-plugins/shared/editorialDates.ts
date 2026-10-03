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
