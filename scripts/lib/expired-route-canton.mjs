/**
 * Resolve the canton that owned one archived route.
 *
 * The archive's top-level `canton` describes the current content winner. A
 * historical alias can have been served under another canton, so transferred
 * aliases carry an exact per-locale slug → canton map. The top-level value is
 * the backward-compatible fallback for rows written before that map existed.
 */
export function resolveExpiredRouteCanton(entry, locale, slug) {
  const mapped = entry?.previousSlugCantonByLocale?.[locale]?.[slug];
  const value = typeof mapped === 'string' && mapped.trim()
    ? mapped
    : entry?.canton;
  const normalized = String(value || '').trim().toUpperCase();
  return normalized || undefined;
}

export function setExpiredRouteCanton(entry, locale, slug, canton) {
  if (!entry || typeof entry !== 'object' || !locale || !slug) return false;
  const normalized = String(canton || '').trim().toUpperCase();
  if (!normalized) return false;
  if (!entry.previousSlugCantonByLocale
    || typeof entry.previousSlugCantonByLocale !== 'object'
    || Array.isArray(entry.previousSlugCantonByLocale)) {
    entry.previousSlugCantonByLocale = {};
  }
  const bySlug = entry.previousSlugCantonByLocale[locale];
  if (!bySlug || typeof bySlug !== 'object' || Array.isArray(bySlug)) {
    entry.previousSlugCantonByLocale[locale] = {};
  }
  if (entry.previousSlugCantonByLocale[locale][slug] === normalized) return false;
  entry.previousSlugCantonByLocale[locale][slug] = normalized;
  return true;
}

export function moveExpiredRouteCanton(entry, locale, fromSlug, toSlug) {
  if (!entry || typeof entry !== 'object' || !locale || !fromSlug || !toSlug) return false;
  const canton = resolveExpiredRouteCanton(entry, locale, fromSlug);
  const changed = setExpiredRouteCanton(entry, locale, toSlug, canton);
  const bySlug = entry.previousSlugCantonByLocale?.[locale];
  if (bySlug && typeof bySlug === 'object' && !Array.isArray(bySlug)
    && Object.prototype.hasOwnProperty.call(bySlug, fromSlug)) {
    delete bySlug[fromSlug];
    if (Object.keys(bySlug).length === 0) delete entry.previousSlugCantonByLocale[locale];
    if (Object.keys(entry.previousSlugCantonByLocale).length === 0) {
      delete entry.previousSlugCantonByLocale;
    }
    return true;
  }
  return changed;
}
