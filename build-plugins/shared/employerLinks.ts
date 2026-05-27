/**
 * Shared employer-link helpers for weekly-employers and job-market-snapshot
 * build plugins.
 *
 * `slugifyEmployer` mirrors the `slugifyCompanyBuild` algorithm used in
 * jobsSeoPagesPlugin so the resulting slug matches the keys stored in
 * `data/all-known-job-slugs.json` (which records `azienda-{slug}` entries
 * written at build time by jobsSeoPagesPlugin).
 *
 * `employerCanonicalHref` checks whether a slug is present in the supplied
 * knownSlugs registry (built from the JSON file above) and returns the
 * canonical company-hub URL when found.
 *
 * `loadKnownCompanySlugs` reads `data/all-known-job-slugs.json` and extracts
 * the set of company slugs (keys prefixed with `azienda-`).
 */

import fs from 'node:fs';
import np from 'node:path';

/**
 * Convert an employer name to the slug used by jobsSeoPagesPlugin when it
 * generates `/cerca-lavoro-ticino/azienda-{slug}/` pages.
 *
 * Algorithm (identical to `slugifyCompanyBuild` in jobsSeoPagesPlugin.ts):
 *   1. Lowercase
 *   2. NFD-normalise and strip combining accents (U+0300–U+036F)
 *   3. Replace any run of non-alphanumeric characters with a single dash
 *   4. Strip leading/trailing dashes
 */
export function slugifyEmployer(name: string): string {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Return the canonical `/cerca-lavoro-ticino/azienda-{slug}/` href when the
 * slug derived from `name` is present in `knownSlugs`, or `null` otherwise.
 */
export function employerCanonicalHref(
  name: string,
  knownSlugs: ReadonlySet<string>,
): string | null {
  const slug = slugifyEmployer(name);
  if (!slug) return null;
  return knownSlugs.has(slug) ? `/cerca-lavoro-ticino/azienda-${slug}/` : null;
}

/**
 * Load the set of canonical company slugs that have deployed
 * `/cerca-lavoro-ticino/azienda-{slug}/` pages.
 *
 * Primary source: `data/known-company-slugs.json` — a JSON array written by
 * `jobsSeoPagesPlugin` during company landing page emission (authoritative,
 * lists all ~227 deployed companies).
 *
 * Fallback: `data/all-known-job-slugs.json` — legacy tracking file that only
 * records bridge pages for old job slugs (keys prefixed `azienda-`). This
 * path is taken on the very first build after a fresh clone, before
 * `known-company-slugs.json` has been generated.
 *
 * Returns an empty Set when both files are missing or malformed.
 */
export function loadKnownCompanySlugs(rootDir: string): Set<string> {
  // Primary source: data/known-company-slugs.json (written by jobsSeoPagesPlugin
  // during company landing page emission — lists actual deployed companies)
  const primary = np.resolve(rootDir, 'data/known-company-slugs.json');
  try {
    const arr: string[] = JSON.parse(fs.readFileSync(primary, 'utf-8'));
    if (Array.isArray(arr) && arr.length > 0) return new Set(arr);
  } catch { /* fall through */ }
  // Fallback: legacy tracking file (only catches bridge pages). This path
  // runs when the primary file hasn't been generated yet (first build).
  const legacy = np.resolve(rootDir, 'data/all-known-job-slugs.json');
  try {
    const raw = fs.readFileSync(legacy, 'utf-8');
    const data: Record<string, unknown> = JSON.parse(raw);
    const slugs = new Set<string>();
    for (const key of Object.keys(data)) {
      if (key.startsWith('azienda-')) slugs.add(key.slice('azienda-'.length));
    }
    return slugs;
  } catch { return new Set(); }
}
