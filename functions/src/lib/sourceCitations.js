/** Source IDs let a model select evidence without rewriting it. Resolution is server-owned. */
export const SOURCE_CITATIONS_VERSION = 'source-citations-v1';

export function sourceCitations(sources) {
  const excerpts = [];
  for (const [source, value] of Object.entries(sources)) {
    for (const line of String(value || '').split(/\r?\n/)) {
      let rest = line.replace(/\s+/gu, ' ').trim();
      while (rest) {
        let end = Math.min(rest.length, 360);
        if (end < rest.length) {
          const space = rest.lastIndexOf(' ', end);
          if (space >= 180) end = space;
          if (/[\uD800-\uDBFF]/u.test(rest[end - 1])) end--;
        }
        excerpts.push({ id: `[[${source}:${excerpts.length}]]`, text: rest.slice(0, end) });
        rest = rest.slice(end).trim();
      }
    }
  }
  const lookup = new Map(excerpts.map(({ id, text }) => [id, text]));
  return { excerpts, resolve: value => lookup.get(String(value || '')) ?? value };
}

/** Keep the public stored schema unchanged; only the provider response uses IDs. */
export function citationSchema(schema, collection, field, citations) {
  const copy = structuredClone(schema);
  copy.properties[collection].items.properties[field] = {
    type: 'string', enum: ['', ...citations.excerpts.map(item => item.id)],
    description: 'One source excerpt ID; empty only when no evidence exists. Never translate or paraphrase.',
  };
  return copy;
}

export function resolveCitations(raw, collection, field, citations) {
  return { ...raw, [collection]: Array.isArray(raw?.[collection])
    ? raw[collection].map(item => ({ ...item, [field]: citations.resolve(item?.[field]) })) : raw?.[collection] };
}
