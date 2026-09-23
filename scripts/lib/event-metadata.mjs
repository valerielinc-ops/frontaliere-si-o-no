/**
 * Small normalizers for optional schema.org Event metadata.
 *
 * They deliberately preserve only named entities and usable HTTP(S) URLs:
 * source JSON-LD is not trusted enough to copy arbitrary objects into the
 * public dataset, and an unnamed organizer/performer is not useful markup.
 */

function absoluteHttpUrl(value, baseUrl) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim(), baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function sourceType(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.find((entry) => typeof entry === 'string' && entry.trim())?.trim();
}

/** Return the first usable image URL from schema.org Image/Object/array forms. */
export function firstEventImageUrl(value, baseUrl) {
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    const raw = typeof entry === 'string' ? entry : entry?.url || entry?.contentUrl || entry?.thumbnailUrl;
    const url = absoluteHttpUrl(raw, baseUrl);
    if (url) return url;
  }
  return undefined;
}

/**
 * Normalize schema.org organizer/performer values while preserving the source
 * entity type and URL when present. A singular source value stays singular;
 * arrays stay arrays so the dataset does not invent cardinality.
 */
export function normalizeEventPeople(value, baseUrl) {
  if (value === undefined || value === null) return undefined;
  const inputWasArray = Array.isArray(value);
  const entries = inputWasArray ? value : [value];
  const seen = new Set();
  const people = [];

  for (const entry of entries) {
    const rawName = typeof entry === 'string' ? entry : entry?.name;
    const name = typeof rawName === 'string' ? rawName.replace(/\s+/g, ' ').trim() : '';
    if (!name) continue;
    const url = absoluteHttpUrl(typeof entry === 'object' ? entry?.url : undefined, baseUrl);
    const key = `${name.toLowerCase()}|${url || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const type = typeof entry === 'object' ? sourceType(entry?.['@type']) : undefined;
    people.push({
      ...(type ? { '@type': type } : {}),
      name,
      ...(url ? { url } : {}),
    });
  }

  if (!people.length) return undefined;
  return inputWasArray ? people : people[0];
}
