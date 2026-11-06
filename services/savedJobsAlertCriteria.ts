/**
 * Saved-jobs → alert-criteria derivation (#4467), extracted out of
 * savedJobsService.ts so it can be imported both from the browser bundle
 * (via the `@/services/...` alias, re-exported there) and directly by plain
 * Node scripts (scripts/send-saved-jobs-digest.mjs's "potrebbero interessarti
 * anche" section) without pulling in that file's `@/`-aliased imports —
 * aliases only resolve under Vite, not Node's native TS type-stripping.
 * Relative imports only, by design.
 */

// NOT imported from ./cantonList.ts: that file does a static `import ... from
// '../data/canton-url-slugs.json'` with no import attribute, which Vite/esbuild
// tolerates but plain Node ESM rejects (ERR_IMPORT_ATTRIBUTE_MISSING) — and this
// file must load under both. The 26 ISO 3166-2:CH canton codes are a stable,
// closed set (unchanged for decades), so a local literal carries no real drift
// risk; mirrors the same list cantonList.ts derives from the JSON.
const CANTON_CODES: readonly string[] = [
  'AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE',
  'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH',
];

export interface SavedJobsAlertCriteria {
  /** Dominant `JobCategory` key across saved jobs, or null when none usable. */
  category: string | null;
  /** Dominant canton as a validated 2-letter code, or null. */
  cantonCode: string | null;
}

interface SavedJobLike {
  category: string | null;
  canton: string | null;
  savedAt: number;
}

/**
 * Majority vote over a field of the saved entries. Ties break toward the value
 * carried by the most recently saved entry (freshest intent wins).
 */
function dominantValue(
  entries: SavedJobLike[],
  pick: (e: SavedJobLike) => string | null,
): string | null {
  const counts = new Map<string, { count: number; lastSavedAt: number }>();
  for (const entry of entries) {
    const value = pick(entry);
    if (!value) continue;
    const bucket = counts.get(value) ?? { count: 0, lastSavedAt: 0 };
    bucket.count += 1;
    bucket.lastSavedAt = Math.max(bucket.lastSavedAt, entry.savedAt);
    counts.set(value, bucket);
  }
  let best: string | null = null;
  let bestCount = 0;
  let bestSavedAt = -1;
  for (const [value, { count, lastSavedAt }] of counts) {
    if (count > bestCount || (count === bestCount && lastSavedAt > bestSavedAt)) {
      best = value;
      bestCount = count;
      bestSavedAt = lastSavedAt;
    }
  }
  return best;
}

/**
 * Derive prefilled alert criteria from the saved list: dominant category and
 * dominant canton (only when it's a real 2-letter code — mirrors the
 * validation `JobBoard.tsx` applies to the job-match profile canton before
 * passing it to `subscribeJobAlertOneTap`).
 */
export function deriveSavedJobsAlertCriteria(entries: SavedJobLike[]): SavedJobsAlertCriteria {
  const category = dominantValue(entries, (e) => e.category);
  const rawCanton = dominantValue(entries, (e) => e.canton);
  const upper = rawCanton ? rawCanton.trim().toUpperCase() : '';
  const cantonCode = upper && (CANTON_CODES as readonly string[]).includes(upper) ? upper : null;
  return { category, cantonCode };
}
