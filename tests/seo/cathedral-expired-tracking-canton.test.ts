// Phase 8 Sub-PR (c) — expired-job soft-landing tracking must be canton-aware.
//
// Before this change, every entry in data/all-known-job-slugs.json was minted
// under the legacy TI section (`/cerca-lavoro-ticino/...`) by the builder in
// jobsSeoPagesPlugin.ts. With cathedral now emitting active per-job pages at
// canton-aware URLs, the soft-landing emitter wrote stale TI URLs and the
// `activeJobDirs.has(...)` collision check missed non-TI active pages.
//
// Two guards in this file:
//   1. Source-level: the tracking builder region of jobsSeoPagesPlugin.ts
//      references the canton-aware section helper (not the hard-coded
//      `sectionByLocale[locale]`).
//   2. Data assertion: tracking entries for non-TI jobs no longer carry
//      legacy TI section path segments.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PLUGIN_PATH = path.resolve(__dirname, '../../build-plugins/jobsSeoPagesPlugin.ts');
const TRACKING_PATH = path.resolve(__dirname, '../../data/all-known-job-slugs.json');
const JOBS_PATH = path.resolve(__dirname, '../../data/jobs.json');

const TI_SECTION_FRAGMENTS = [
  '/cerca-lavoro-ticino/',
  '/find-jobs-ticino/',
  '/jobs-im-tessin/',
  '/trouver-emploi-tessin/',
] as const;

describe('Phase 8c — expired-tracking is canton-aware', () => {
  it('source: tracking[job.slug][locale] builder uses buildCantonAwareSection', () => {
    const src = fs.readFileSync(PLUGIN_PATH, 'utf8');
    // Locate the tracking builder region by anchor strings that surround it.
    const anchor = 'if (!tracking[job.slug]) {';
    const idx = src.indexOf(anchor);
    expect(idx).toBeGreaterThan(-1);
    // Look at the next ~600 chars (the small if-block builds the entry).
    const region = src.slice(idx, idx + 800);
    expect(region).toMatch(/buildCantonAwareSection|sharedResolveCantonSection/);
    // And it must NOT still hard-code sectionByLocale[locale] inside the
    // tracking-entry builder.
    expect(region).not.toMatch(/sectionByLocale\[locale\]/);
  });

  it('data: non-TI tracking entries no longer reference the TI section path', () => {
    if (!fs.existsSync(JOBS_PATH) || !fs.existsSync(TRACKING_PATH)) return;
    const jobs: Array<{
      slug?: string;
      canton?: string;
      location?: string;
      slugByLocale?: Record<string, string>;
      previousSlugs?: string[];
    }> = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
    const tracking: Record<string, Record<string, string>> = JSON.parse(
      fs.readFileSync(TRACKING_PATH, 'utf8'),
    );

    // Build slug-alias -> job index so we can look up by tracking key.
    const slugToJob = new Map<string, (typeof jobs)[number]>();
    for (const job of jobs) {
      const aliases = new Set<string>();
      if (job.slug) aliases.add(job.slug);
      if (job.slugByLocale) {
        for (const v of Object.values(job.slugByLocale)) if (v) aliases.add(v);
      }
      if (Array.isArray(job.previousSlugs)) {
        for (const v of job.previousSlugs) if (v) aliases.add(v);
      }
      for (const a of aliases) if (!slugToJob.has(a)) slugToJob.set(a, job);
    }

    // Sample non-TI jobs that ARE represented in tracking.
    const nonTiJobs = jobs.filter((j) => {
      const c = String(j.canton || '').toUpperCase();
      if (!c || c === 'TI') return false;
      const key = j.slug && tracking[j.slug] ? j.slug : null;
      return Boolean(key);
    });
    if (nonTiJobs.length === 0) return; // dataset has no non-TI jobs

    // Deterministic sample (first 20 sorted by slug) — covers multiple cantons
    // and keeps the assertion cheap.
    const sample = nonTiJobs
      .slice()
      .sort((a, b) => String(a.slug).localeCompare(String(b.slug)))
      .slice(0, 20);

    for (const job of sample) {
      const entry = tracking[job.slug!];
      expect(entry).toBeTruthy();
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        const p = entry[locale];
        if (typeof p !== 'string') continue;
        for (const frag of TI_SECTION_FRAGMENTS) {
          expect(p, `non-TI job ${job.slug} (canton=${job.canton}) [${locale}] still references ${frag}: ${p}`).not.toContain(frag);
        }
      }
    }
  });
});
