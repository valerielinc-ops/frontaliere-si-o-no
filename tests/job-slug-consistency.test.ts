import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const LOCALES = ['it', 'en', 'de', 'fr'] as const;

/**
 * Reproduce the same slug derivation logic as JobBoard.tsx's
 * deriveLocalizedJobSlug() to verify the slim index produces
 * the same slug as the full dataset.
 *
 * This catches the bug where the slim index (stripped of slugByLocale)
 * caused the SPA to derive a different slug from title-company-location
 * instead of using the flattened slug field.
 */
function slugifyJobPart(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

function deriveSlugFromSlimIndex(job: Record<string, unknown>, locale: string): string {
  // This is the FIXED logic: check slug first, then fall back to title-company-location
  const explicit = String((job.slugByLocale as Record<string, string>)?.[locale] || '').trim();
  if (explicit) return explicit;
  const canonical = String(job.slug || '').trim();
  if (canonical) return canonical;
  const title = String((job.titleByLocale as Record<string, string>)?.[locale] || job.title || '').trim();
  const company = String(job.company || '').trim();
  const location = String(job.location || '').trim();
  return slugifyJobPart(`${title}-${company}-${location}`) || slugifyJobPart(title);
}

describe('Job slug consistency (post-build)', () => {
  for (const locale of LOCALES) {
    const slimPath = path.join(DIST_DIR, 'data', `jobs-${locale}-index.json`);
    const fullPath = path.join(DIST_DIR, 'data', `jobs-${locale}.json`);

    it(`[${locale}] slim index slug matches full locale slug for every job`, () => {
      if (!existsSync(slimPath) || !existsSync(fullPath)) {
        console.warn(`Skipping ${locale}: dist files not found (run vite build first)`);
        return;
      }

      const slimJobs: Record<string, unknown>[] = JSON.parse(readFileSync(slimPath, 'utf-8'));
      const fullJobs: Record<string, unknown>[] = JSON.parse(readFileSync(fullPath, 'utf-8'));

      // Build full-jobs slug index for O(1) lookup
      const fullSlugById = new Map<string, string>();
      for (const job of fullJobs) {
        const id = String(job.id || '');
        const slug = String(job.slug || '').trim();
        if (id && slug) fullSlugById.set(id, slug);
      }

      const mismatches: string[] = [];
      for (const slimJob of slimJobs) {
        const id = String(slimJob.id || '');
        const derivedSlug = deriveSlugFromSlimIndex(slimJob, locale);
        const expectedSlug = fullSlugById.get(id);

        if (expectedSlug && derivedSlug !== expectedSlug) {
          mismatches.push(
            `${id}: derived="${derivedSlug}" expected="${expectedSlug}" company="${slimJob.company}"`
          );
        }
      }

      expect(
        mismatches,
        `${mismatches.length} jobs have slug mismatch between slim index and full locale file:\n${mismatches.slice(0, 10).join('\n')}`
      ).toEqual([]);
    });
  }

  it('every job in the slim index has a non-empty slug field', () => {
    const slimPath = path.join(DIST_DIR, 'data', 'jobs-it-index.json');
    if (!existsSync(slimPath)) {
      console.warn('Skipping: dist files not found');
      return;
    }

    const slimJobs: Record<string, unknown>[] = JSON.parse(readFileSync(slimPath, 'utf-8'));
    const missing = slimJobs.filter(j => !String(j.slug || '').trim());
    expect(
      missing.map(j => j.id),
      `${missing.length} jobs have empty slug in slim index`
    ).toEqual([]);
  });
});
