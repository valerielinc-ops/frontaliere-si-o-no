import { existsSync, readFileSync } from 'node:fs';

/**
 * Apply a reviewed, source-specific editorial correction to an event.
 *
 * Crawlers remain lossless: the source record is preserved, while this small
 * public registry records corrections supplied by an organiser or artist.
 * Overrides are keyed by the stable event id and are re-applied on every
 * assembly, so the next crawl cannot silently undo a correction.
 */
export function applyEditorialOverride(event, registry = {}) {
  if (!event || typeof event !== 'object' || !event.id) return event;
  const override = registry?.overrides?.[event.id];
  if (!override || typeof override !== 'object') return event;

  const next = { ...event };
  if (typeof override.category === 'string' && override.category.trim()) {
    next.category = override.category.trim();
  }
  if (typeof override.musicStyle === 'string' && override.musicStyle.trim()) {
    next.musicStyle = override.musicStyle.trim();
  }
  if (typeof override.description === 'string' && override.description.trim()) {
    next.description = override.description.trim();
  }
  if (override.descriptionByLocale && typeof override.descriptionByLocale === 'object') {
    const descriptions = Object.fromEntries(
      Object.entries(override.descriptionByLocale)
        .filter(([, value]) => typeof value === 'string' && value.trim())
        .map(([locale, value]) => [locale, value.trim()]),
    );
    if (Object.keys(descriptions).length) {
      next.descriptionByLocale = { ...(event.descriptionByLocale || {}), ...descriptions };
    }
  }
  return next;
}

export function loadEditorialOverrides(filePath) {
  if (!filePath || !existsSync(filePath)) return { schemaVersion: 1, overrides: {} };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.overrides && typeof parsed.overrides === 'object'
      ? parsed
      : { schemaVersion: 1, overrides: {} };
  } catch {
    return { schemaVersion: 1, overrides: {} };
  }
}
