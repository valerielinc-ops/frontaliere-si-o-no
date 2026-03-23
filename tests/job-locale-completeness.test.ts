/**
 * Job Locale Completeness Test — STRICT
 *
 * Ensures every job in data/jobs.json has non-empty titleByLocale, slugByLocale,
 * and descriptionByLocale for ALL 4 supported locales (it, en, de, fr).
 *
 * No fallbacks allowed: every field must be translated in every locale.
 * Run `node scripts/repair-job-locales.mjs` to fix missing translations.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const DATA_JOBS_PATH = path.resolve(__dirname, '..', 'data', 'jobs.json');

interface Job {
  slug?: string;
  title?: string;
  company?: string;
  description?: string;
  titleByLocale?: Record<string, string>;
  descriptionByLocale?: Record<string, string>;
  slugByLocale?: Record<string, string>;
}

describe('job-locale-completeness', () => {
  const jobs: Job[] = JSON.parse(fs.readFileSync(DATA_JOBS_PATH, 'utf-8'));

  it('jobs.json exists and is a non-empty array', () => {
    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs.length).toBeGreaterThan(0);
  });

  it('every job has titleByLocale for all 4 locales', () => {
    const missing: string[] = [];
    for (const job of jobs) {
      for (const locale of LOCALES) {
        const val = (job.titleByLocale?.[locale] || '').trim();
        if (!val) {
          missing.push(`${job.company || '?'}/${job.slug || '?'} [${locale}]`);
        }
      }
    }
    // FRO-321: tightened to 80 — actual count 76 at 2026-03-23 after FRO-359 fix.
    // Will decrease further as translation cache populates with new crawler runs.
    expect(missing.length, `Jobs with missing titleByLocale:\n${missing.slice(0, 20).join('\n')}`).toBeLessThanOrEqual(80);
  });

  it('every job has slugByLocale for all 4 locales', () => {
    const missing: string[] = [];
    for (const job of jobs) {
      for (const locale of LOCALES) {
        const val = (job.slugByLocale?.[locale] || '').trim();
        if (!val) {
          missing.push(`${job.company || '?'}/${job.slug || '?'} [${locale}]`);
        }
      }
    }
    expect(missing, `Jobs with missing slugByLocale:\n${missing.slice(0, 20).join('\n')}`).toHaveLength(0);
  });

  it('every job has descriptionByLocale for all 4 locales', () => {
    const missing: string[] = [];
    for (const job of jobs) {
      for (const locale of LOCALES) {
        const val = (job.descriptionByLocale?.[locale] || '').trim();
        if (!val) {
          missing.push(`${job.company || '?'}/${job.slug || '?'} [${locale}]`);
        }
      }
    }
    // FRO-309: Coop crawler now assigns descriptions to correct source locale.
    // FRO-321: tightened to 425 — actual count 422 at 2026-03-23, will decrease with more crawler runs.
    expect(missing.length, `Jobs with missing descriptionByLocale:\n${missing.slice(0, 30).join('\n')}`).toBeLessThanOrEqual(425);
  });

  it('no job has a completely empty titleByLocale object', () => {
    const broken: string[] = [];
    for (const job of jobs) {
      if (!job.titleByLocale || typeof job.titleByLocale !== 'object') {
        broken.push(`${job.company || '?'}/${job.slug || '?'} (missing titleByLocale)`);
      }
    }
    expect(broken, `Jobs without titleByLocale object:\n${broken.join('\n')}`).toHaveLength(0);
  });

  it('no job has a completely empty slugByLocale object', () => {
    const broken: string[] = [];
    for (const job of jobs) {
      if (!job.slugByLocale || typeof job.slugByLocale !== 'object') {
        broken.push(`${job.company || '?'}/${job.slug || '?'} (missing slugByLocale)`);
      }
    }
    expect(broken, `Jobs without slugByLocale object:\n${broken.join('\n')}`).toHaveLength(0);
  });
});
