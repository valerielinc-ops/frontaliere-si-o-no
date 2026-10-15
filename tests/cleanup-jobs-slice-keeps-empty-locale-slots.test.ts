/**
 * Issue 6109 (job descriptions stuck in the source language): the weekly
 * slice housekeeping (`cleanup-stale-jobs.yml` → `cleanup-stale-job-slices.sh`
 * → `JOBS_SLICE_FILE=<slice> node scripts/cleanup-jobs.mjs`) ran the locale
 * hardening on the slice and wrote it back to git with every EMPTY non-source
 * title/description slot filled by a byte copy of the source text. Measured on
 * the 2026-10-04 11:06 housekeeping commit: 822 slots on 178 jobs, 161 of them
 * Coop jobs whose `it`/`en`/`fr` slots had been left empty by the crawler
 * ("to translate") and came out looking filled.
 *
 * The copy exists only for the publish gate, which reads the BUILD-TIME
 * dataset (deploy.yml `prep` re-hardens the assembled data/jobs.json). A slice
 * committed to git must keep the empty slot empty and flagged.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hardenJobLocaleFields, resetHardenCache } from '../scripts/lib/dedicated-crawler-common.mjs';

const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/cleanup-jobs.mjs');
const NON_SOURCE_LOCALES = ['it', 'en', 'fr'] as const;

const SOURCE_TITLE = 'Verkäufer:in Food';
const SOURCE_DESCRIPTION = [
  '## Verkäufer:in Food',
  '',
  '## Aufgaben',
  '- Du berätst unsere Kundinnen und Kunden kompetent und freundlich im Verkauf.',
  '- Du sorgst für eine attraktive Präsentation der Frischprodukte in der Filiale.',
  '',
  '## Anforderungen',
  '- Du hast Erfahrung im Detailhandel und sprichst sehr gut Deutsch.',
].join('\n');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
  resetHardenCache();
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-slice-empty-slots-'));
  tempDirs.push(dir);
  return dir;
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

function untranslatedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'company-wfr4nz',
    slug: 'verkaufer-in-food-coop-genossenschaft-zurich',
    company: 'Coop Genossenschaft',
    title: SOURCE_TITLE,
    location: 'Zürich',
    addressLocality: 'Zürich',
    postalCode: '8001',
    streetAddress: 'Bahnhofstrasse 1',
    url: 'https://example.test/jobs/410001',
    description: SOURCE_DESCRIPTION,
    sourceLang: 'de',
    crawledAt: daysAgo(1),
    firstSeenAt: daysAgo(1),
    needsRetranslation: true,
    titleByLocale: { de: SOURCE_TITLE },
    descriptionByLocale: { de: SOURCE_DESCRIPTION },
    slugByLocale: { de: 'verkaufer-in-food-coop-genossenschaft-zurich' },
    ...overrides,
  };
}

async function runSliceHousekeeping(slicePath: string, dir: string): Promise<{ code: number | null; output: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        JOBS_SLICE_FILE: slicePath,
        JOBS_SKIP_URL_VALIDATION: '1',
        JOBS_STALE_DAYS: '60',
        JOBS_EXPIRED_SLICES_DIR: path.join(dir, 'expired'),
        SLUG_REGISTRY_PATH_OVERRIDE: path.join(dir, 'slug-registry.json'),
        // Hardening ON: this is the unscoped weekly run of cleanup-stale-jobs.yml.
        JOBS_SKIP_LOCALE_HARDENING: '',
        JOBS_HOUSEKEEPING_SCOPE: '',
        GITHUB_SHA: 'test-housekeeping-sha',
        GITHUB_RUN_ID: 'test-housekeeping-run',
        GITHUB_RUN_ATTEMPT: '1',
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('slice housekeeping keeps empty locale slots empty (issue 6109)', () => {
  it('does not commit a source copy into the empty slots of a slice it rewrites', async () => {
    const dir = makeTempDir();
    const slicePath = path.join(dir, 'coop-ticino.json');
    fs.writeFileSync(path.join(dir, 'slug-registry.json'), '{}\n');
    // A stale job (> 60 days) forces the slice rewrite, like the expired
    // listings that made the 2026-10-04 run write coop-ticino.json.
    const stale = untranslatedJob({
      id: 'company-stale1',
      slug: 'stale-job-coop-genossenschaft-zurich',
      url: 'https://example.test/jobs/410002',
      crawledAt: daysAgo(90),
    });
    fs.writeFileSync(
      slicePath,
      JSON.stringify({ crawlerKey: 'coop-ticino', jobs: [untranslatedJob(), stale] }, null, 2),
    );

    const { code, output } = await runSliceHousekeeping(slicePath, dir);
    expect(code, output).toBe(0);
    expect(output).toContain('Slice cleaned');

    const written = JSON.parse(fs.readFileSync(slicePath, 'utf8'));
    const job = written.jobs.find((j: { id: string }) => j.id === 'company-wfr4nz');
    expect(job).toBeDefined();
    for (const locale of NON_SOURCE_LOCALES) {
      expect(String(job.descriptionByLocale?.[locale] ?? ''), `description.${locale}`).toBe('');
      expect(String(job.titleByLocale?.[locale] ?? ''), `title.${locale}`).not.toBe(SOURCE_TITLE);
    }
    expect(job.descriptionByLocale.de).toBe(SOURCE_DESCRIPTION);
    expect(job.needsRetranslation).toBe(true);
  });

  it('keeps the build-time fill (default) for the publish gate, and only that caller', () => {
    const dir = makeTempDir();
    const build = path.join(dir, 'jobs-build.json');
    const slice = path.join(dir, 'jobs-slice.json');
    const prevRegistry = process.env.SLUG_REGISTRY_PATH_OVERRIDE;
    process.env.SLUG_REGISTRY_PATH_OVERRIDE = path.join(dir, 'slug-registry.json');
    try {
      fs.writeFileSync(path.join(dir, 'slug-registry.json'), '{}\n');
      fs.writeFileSync(build, JSON.stringify([untranslatedJob()]));
      fs.writeFileSync(slice, JSON.stringify([untranslatedJob()]));

      hardenJobLocaleFields({ dataJobsPath: build });
      hardenJobLocaleFields({ dataJobsPath: slice, fillEmptyWithSourceCopy: false });

      const [built] = JSON.parse(fs.readFileSync(build, 'utf8'));
      const [kept] = JSON.parse(fs.readFileSync(slice, 'utf8'));
      for (const locale of NON_SOURCE_LOCALES) {
        expect(built.descriptionByLocale[locale]).toBe(SOURCE_DESCRIPTION);
        expect(String(kept.descriptionByLocale?.[locale] ?? '')).toBe('');
        expect(String(kept.titleByLocale?.[locale] ?? '')).not.toBe(SOURCE_TITLE);
      }
      expect(kept.needsRetranslation).toBe(true);
    } finally {
      if (prevRegistry === undefined) delete process.env.SLUG_REGISTRY_PATH_OVERRIDE;
      else process.env.SLUG_REGISTRY_PATH_OVERRIDE = prevRegistry;
    }
  });

  it('flags an empty slot it leaves empty even when the job was not flagged yet', () => {
    const dir = makeTempDir();
    const slice = path.join(dir, 'jobs-slice.json');
    const prevRegistry = process.env.SLUG_REGISTRY_PATH_OVERRIDE;
    process.env.SLUG_REGISTRY_PATH_OVERRIDE = path.join(dir, 'slug-registry.json');
    try {
      fs.writeFileSync(path.join(dir, 'slug-registry.json'), '{}\n');
      fs.writeFileSync(slice, JSON.stringify([untranslatedJob({ needsRetranslation: undefined })]));
      hardenJobLocaleFields({ dataJobsPath: slice, fillEmptyWithSourceCopy: false });
      const [kept] = JSON.parse(fs.readFileSync(slice, 'utf8'));
      expect(String(kept.descriptionByLocale?.it ?? '')).toBe('');
      expect(kept.needsRetranslation).toBe(true);
    } finally {
      if (prevRegistry === undefined) delete process.env.SLUG_REGISTRY_PATH_OVERRIDE;
      else process.env.SLUG_REGISTRY_PATH_OVERRIDE = prevRegistry;
    }
  });
});
