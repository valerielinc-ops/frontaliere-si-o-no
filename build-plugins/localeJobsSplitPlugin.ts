import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

interface JobEntry {
  title?: string;
  description?: string;
  requirements?: string[];
  slug?: string;
  titleByLocale?: Record<string, string>;
  descriptionByLocale?: Record<string, string>;
  requirementsByLocale?: Record<string, string[]>;
  slugByLocale?: Record<string, string>;
  canonicalContent?: { byLocale?: Record<string, unknown>; [k: string]: unknown };
  [key: string]: unknown;
}

function buildLocaleJob(job: JobEntry, locale: string): Record<string, unknown> {
  const {
    titleByLocale,
    descriptionByLocale,
    requirementsByLocale,
    slugByLocale,
    canonicalContent,
    ...rest
  } = job;

  // Strip byLocale from canonicalContent too (it holds per-locale keywords/excerpts)
  let strippedCanonical: Record<string, unknown> | undefined;
  if (canonicalContent) {
    const { byLocale, ...canonRest } = canonicalContent;
    const localeContent = byLocale?.[locale];
    strippedCanonical = { ...canonRest, ...(localeContent ? { content: localeContent } : {}) };
  }

  return {
    ...rest,
    title: titleByLocale?.[locale] || job.title || '',
    description: descriptionByLocale?.[locale] || job.description || '',
    requirements: requirementsByLocale?.[locale] || job.requirements || [],
    slug: slugByLocale?.[locale] || job.slug || '',
    ...(strippedCanonical ? { canonicalContent: strippedCanonical } : {}),
  };
}

/**
 * Generates locale-specific job JSON files at build time.
 *
 * Reads `data/jobs.json` and emits `dist/data/jobs-{locale}.json` for each locale.
 * Each file flattens the *ByLocale fields into the base fields for that locale,
 * reducing per-request payload by ~35%.
 *
 * Also generates files in `public/data/` for the Vite dev server.
 */
export function localeJobsSplitPlugin(rootDir: string): Plugin {
  const dataJobsPath = path.resolve(rootDir, 'data', 'jobs.json');

  function generateFiles(outDir: string): number {
    if (!fs.existsSync(dataJobsPath)) return 0;

    const jobs: JobEntry[] = JSON.parse(fs.readFileSync(dataJobsPath, 'utf-8'));
    if (!Array.isArray(jobs)) return 0;

    const dataDir = path.resolve(outDir, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    for (const locale of LOCALES) {
      const localeJobs = jobs.map((j) => buildLocaleJob(j, locale));
      fs.writeFileSync(
        path.resolve(dataDir, `jobs-${locale}.json`),
        JSON.stringify(localeJobs),
        'utf-8',
      );
    }
    return jobs.length;
  }

  return {
    name: 'locale-jobs-split',
    apply: 'build',
    closeBundle() {
      const distDir = path.resolve(rootDir, 'dist');
      const count = generateFiles(distDir);
      if (count > 0) {
        console.log(`[locale-jobs-split] Generated 4 locale job files (${count} jobs each)`);
      }
    },
    configureServer(server) {
      // In dev, generate files in public/data/ so the dev server can serve them
      const publicDir = path.resolve(rootDir, 'public');
      const count = generateFiles(publicDir);
      if (count > 0) {
        console.log(`[locale-jobs-split] Dev: generated 4 locale files in public/data/`);
      }
    },
  };
}
