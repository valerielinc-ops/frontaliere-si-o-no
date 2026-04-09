/**
 * Cross-locale content leakage guard
 *
 * Prevents regressions where a job's canonical content for one locale
 * (e.g. Italian) accidentally returns another locale's text (e.g. German).
 *
 * Root causes that were fixed:
 * - A structuralScore heuristic preferring the "richest" locale regardless of request
 * - Object.values().find() fallback in readCanonicalLocaleContent that could pick any locale
 * - readCanonicalByLocale in jobsSeoPagesPlugin falling back to other locales
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const DATA_JOBS_PATH = path.resolve(__dirname, '..', 'data', 'jobs.json');

interface CanonicalEntry {
  summary?: string[];
  sections?: Array<{ heading?: string; paragraphs?: string[]; bullets?: string[] }>;
  responsibilities?: string[];
  requirements?: string[];
  benefits?: string[];
  keywords?: string[];
}

interface Job {
  slug?: string;
  company?: string;
  needsRetranslation?: boolean;
  canonicalContent?: {
    byLocale?: Partial<Record<string, CanonicalEntry>>;
  };
}

/** Flatten a canonical entry's text into a single comparable string. */
function flattenCanonical(entry: CanonicalEntry): string {
  const parts: string[] = [];
  if (entry.summary) parts.push(...entry.summary);
  if (entry.responsibilities) parts.push(...entry.responsibilities);
  if (entry.requirements) parts.push(...entry.requirements);
  if (entry.benefits) parts.push(...entry.benefits);
  if (entry.sections) {
    for (const s of entry.sections) {
      if (s.paragraphs) parts.push(...s.paragraphs);
      if (s.bullets) parts.push(...s.bullets);
    }
  }
  return parts.join(' ').trim();
}

describe('cross-locale content leakage guard', () => {
  const jobs: Job[] = JSON.parse(fs.readFileSync(DATA_JOBS_PATH, 'utf-8'));
  const jobsWithCanonical = jobs.filter(j => j.canonicalContent?.byLocale && !j.needsRetranslation);

  it('jobs with canonicalContent exist', () => {
    expect(jobsWithCanonical.length).toBeGreaterThan(0);
  });

  it('Italian canonical content must not be identical to German canonical content', () => {
    const leaked: string[] = [];
    for (const job of jobsWithCanonical) {
      const byLocale = job.canonicalContent!.byLocale!;
      const it = byLocale.it;
      const de = byLocale.de;
      if (!it || !de) continue;
      const itText = flattenCanonical(it);
      const deText = flattenCanonical(de);
      if (!itText || !deText) continue;
      // If Italian text is byte-identical to German text, it's a cross-locale leak
      if (itText === deText) {
        leaked.push(`${job.company}/${job.slug}`);
      }
    }
    expect(
      leaked,
      `Jobs where IT canonical === DE canonical (cross-locale leak):\n${leaked.slice(0, 10).join('\n')}`
    ).toHaveLength(0);
  });

  it('no two locale entries share identical summary arrays (unless both are empty)', () => {
    const leaked: string[] = [];
    for (const job of jobsWithCanonical) {
      const byLocale = job.canonicalContent!.byLocale!;
      const entries = Object.entries(byLocale) as [string, CanonicalEntry][];
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const [locA, a] = entries[i];
          const [locB, b] = entries[j];
          const summA = (a.summary || []).join('|');
          const summB = (b.summary || []).join('|');
          if (summA && summB && summA === summB) {
            leaked.push(`${job.company}/${job.slug} [${locA}==${locB}]`);
          }
        }
      }
    }
    expect(
      leaked,
      `Jobs with identical summaries across locales:\n${leaked.slice(0, 10).join('\n')}`
    ).toHaveLength(0);
  });

  it('readCanonicalByLocale pattern must not fall back to other locales', () => {
    // Unit test for the exact pattern used in jobsSeoPagesPlugin.ts and JobBoard.tsx
    const readCanonicalByLocale = (job: any, locale: string) => {
      const byLocale = job?.canonicalContent?.byLocale || {};
      return byLocale?.[locale] || null;
    };

    const mockJob = {
      canonicalContent: {
        byLocale: {
          de: { summary: ['German summary'] },
          // Italian is intentionally missing
        },
      },
    };

    // Requesting 'it' must return null, NOT the German entry
    expect(readCanonicalByLocale(mockJob, 'it')).toBeNull();
    // Requesting 'de' must return the German entry
    expect(readCanonicalByLocale(mockJob, 'de')).toEqual({ summary: ['German summary'] });
    // Missing canonicalContent must return null
    expect(readCanonicalByLocale({}, 'it')).toBeNull();
    expect(readCanonicalByLocale(null, 'it')).toBeNull();
  });

  it('no structuralScore or Object.values fallback pattern exists in JobBoard.tsx', () => {
    const jobBoardSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'components', 'community', 'JobBoard.tsx'),
      'utf-8'
    );
    // The structuralScore heuristic was the root cause of preferring German over Italian
    expect(jobBoardSource).not.toContain('structuralScore');
    // Object.values().find() on byLocale was the fallback that caused cross-locale leaks
    expect(jobBoardSource).not.toMatch(/Object\.values\s*\(\s*byLocale\s*\)\.find/);
  });

  it('readCanonicalByLocale in jobsSeoPagesPlugin must not fall back to other locales', () => {
    const pluginSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'build-plugins', 'jobsSeoPagesPlugin.ts'),
      'utf-8'
    );
    // Must not contain Object.values fallback on byLocale
    expect(pluginSource).not.toMatch(/Object\.values\s*\(\s*byLocale\s*\)\.find/);
    // Must not contain structuralScore
    expect(pluginSource).not.toContain('structuralScore');
  });
});
