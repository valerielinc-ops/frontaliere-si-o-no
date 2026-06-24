/**
 * Shared shape helpers for the expired-jobs split (expiredJobsSplitPlugin) and
 * its runtime consumer (hooks/useExpiredJob.ts). Single source of truth so the
 * emitter and the client can't drift on which fields live in the slim index vs
 * the per-entry detail file.
 *
 * The full `expired-jobs.json` (5000 entries × descriptionByLocale ×4 locales,
 * ~56MB / ~11MB gz) used to be fetched whole on every SPA navigation to an
 * expired job. We split it into:
 *   - `expired-jobs-index.json` — slim: every field EXCEPT descriptionByLocale,
 *     plus a `key` pointing at the detail file. Carries all slug variants
 *     (slug, slugByLocale, previousSlugs, previousSlugsByLocale) so the client
 *     can resolve any landing slug to its entry. ~1MB gz.
 *   - `expired-detail/<key>.json` — the full entry incl descriptionByLocale.
 */

/** Fields dropped from the slim index (heavy prose, fetched lazily per entry). */
const DETAIL_ONLY_EXPIRED_FIELDS = new Set(['descriptionByLocale']);

/** Stable, filesystem-safe detail-file key for an expired entry. URL-safe slugs
 * map to themselves; anything else is sanitised and length-capped (filesystem
 * 255-byte limit) so the emit never fails on a pathological slug. Uniqueness
 * across the corpus is enforced by the caller (see makeKeyAssigner). */
export function sanitizeExpiredKey(slug: string | undefined | null): string {
  const base = String(slug || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
  return base || 'unknown';
}

/** Returns a key assigner that guarantees uniqueness: on collision it appends
 * an incrementing suffix. Use one assigner per emit pass. */
export function makeExpiredKeyAssigner(): (slug: string | undefined | null) => string {
  const seen = new Set<string>();
  return (slug) => {
    const base = sanitizeExpiredKey(slug);
    let key = base;
    let n = 1;
    while (seen.has(key)) {
      key = `${base}-${n}`;
      n += 1;
    }
    seen.add(key);
    return key;
  };
}

/** Build the slim index entry (everything except descriptionByLocale) + key. */
export function buildSlimExpiredEntry(
  entry: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const slim: Record<string, unknown> = { key };
  for (const [field, value] of Object.entries(entry)) {
    if (DETAIL_ONLY_EXPIRED_FIELDS.has(field)) continue;
    if (value !== undefined) slim[field] = value;
  }
  return slim;
}
