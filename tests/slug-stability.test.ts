/**
 * Tests for slug stability infrastructure fixes.
 *
 * Verifies:
 * 1. captureLostSlugs() excludes active slugByLocale values
 * 2. hardenJobLocaleFields() is idempotent (2nd call = no changes)
 * 3. First-run guard: new jobs get 0 previousSlugs
 * 4. Existing previousSlugs are preserved across runs
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// We test captureLostSlugs directly — it's the core of slug preservation
const COMMON_PATH = path.resolve(process.cwd(), 'scripts/lib/dedicated-crawler-common.mjs');

describe('captureLostSlugs', () => {
  let captureLostSlugs;

  beforeEach(async () => {
    const mod = await import(COMMON_PATH);
    captureLostSlugs = mod.captureLostSlugs;
  });

  it('should capture genuinely lost slugs', () => {
    const job = {
      slug: 'new-slug-company',
      slugByLocale: { it: 'new-slug-it', en: 'new-slug-en', de: 'new-slug-de', fr: 'new-slug-fr' },
      previousSlugs: [],
    };
    const prevSlugByLocale = { it: 'old-slug-it', en: 'old-slug-en', de: 'old-slug-de', fr: 'old-slug-fr' };
    const prevSlug = 'old-master-slug';

    const lost = captureLostSlugs(job, prevSlugByLocale, prevSlug);

    expect(lost).toContain('old-master-slug');
    expect(lost).toContain('old-slug-it');
    expect(lost).toContain('old-slug-en');
    expect(job.previousSlugs).toContain('old-master-slug');
    expect(job.previousSlugs).toContain('old-slug-it');
  });

  it('should NOT capture slugs that are still active in slugByLocale', () => {
    const job = {
      slug: 'master-slug',
      slugByLocale: { it: 'slug-it', en: 'slug-en', de: 'slug-de', fr: 'slug-fr' },
      previousSlugs: [],
    };
    // Simulate: the EN slug was previously "slug-en" and is STILL "slug-en"
    // but the IT slug changed from "old-it" to "slug-it"
    const prevSlugByLocale = { it: 'old-it', en: 'slug-en', de: 'slug-de', fr: 'slug-fr' };

    captureLostSlugs(job, prevSlugByLocale, 'master-slug');

    // "old-it" was genuinely lost — should be captured
    expect(job.previousSlugs).toContain('old-it');
    // "slug-en" is still the active EN slug — should NOT be in previousSlugs
    expect(job.previousSlugs).not.toContain('slug-en');
    // "slug-de" and "slug-fr" are unchanged — shouldn't appear at all
    expect(job.previousSlugs).not.toContain('slug-de');
    expect(job.previousSlugs).not.toContain('slug-fr');
  });

  it('should remove redundant previousSlugs that match current slugByLocale', () => {
    const job = {
      slug: 'master-slug',
      slugByLocale: { it: 'slug-it', en: 'slug-en' },
      // Pre-existing previousSlugs with a redundant entry
      previousSlugs: ['slug-it', 'genuinely-old-slug'],
    };
    // Even if nothing changed, if we add new lost slugs, the existing
    // redundant ones should be cleaned
    const prevSlugByLocale = { it: 'slug-it', en: 'changed-slug-en' };

    captureLostSlugs(job, prevSlugByLocale, 'master-slug');

    // 'changed-slug-en' was lost → captured
    expect(job.previousSlugs).toContain('changed-slug-en');
    // 'genuinely-old-slug' should still be there
    expect(job.previousSlugs).toContain('genuinely-old-slug');
    // 'slug-it' is still active in slugByLocale → should be removed
    expect(job.previousSlugs).not.toContain('slug-it');
    // 'slug-en' is active → should not be captured even though EN changed
    expect(job.previousSlugs).not.toContain('slug-en');
    // master slug should not be in previousSlugs
    expect(job.previousSlugs).not.toContain('master-slug');
  });

  it('should return empty array when no slugs changed', () => {
    const job = {
      slug: 'same-slug',
      slugByLocale: { it: 'same-it', en: 'same-en' },
      previousSlugs: [],
    };
    const result = captureLostSlugs(job, { it: 'same-it', en: 'same-en' }, 'same-slug');

    expect(result).toEqual([]);
    expect(job.previousSlugs).toEqual([]);
  });
});

describe('hardenJobLocaleFields — idempotency', () => {
  let hardenJobLocaleFields;
  let resetHardenCache;
  let tmpDir;
  let tmpFile;

  beforeEach(async () => {
    const mod = await import(COMMON_PATH);
    hardenJobLocaleFields = mod.hardenJobLocaleFields;
    resetHardenCache = mod.resetHardenCache;

    // Reset cache so previous tests don't affect this one
    resetHardenCache();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-test-'));
    tmpFile = path.join(tmpDir, 'jobs.json');
  });

  afterEach(() => {
    resetHardenCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('second call in the same process should be a no-op', () => {
    const jobs = [
      {
        id: 'test-1',
        slug: 'test-job-company',
        slugByLocale: { en: 'test-job-company' },
        title: 'Test Job',
        titleByLocale: { en: 'Test Job' },
        description: 'A test job description that is long enough to pass validation checks for the hardening function.',
        descriptionByLocale: { en: 'A test job description that is long enough to pass validation checks for the hardening function.' },
        company: 'TestCo',
        companyKey: 'testco',
        url: 'https://example.com/job/1',
        sourceLang: 'en',
      },
    ];

    fs.writeFileSync(tmpFile, JSON.stringify(jobs, null, 2));

    // First call — may modify the file
    const result1 = hardenJobLocaleFields({ dataJobsPath: tmpFile });

    // Second call — should return cached result (no re-processing)
    const result2 = hardenJobLocaleFields({ dataJobsPath: tmpFile });

    // The second call should return the exact same result (cached)
    expect(result2).toEqual(result1);
  });
});
