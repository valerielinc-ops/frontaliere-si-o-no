import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { makeKey } from '@/services/previousSlugWinners';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(REPO_ROOT, 'dist');

describe('cathedral Phase 8b — previousSlugs bridges canton-aware', () => {
  // ── Structural guard: makeKey() is canton-aware ───────────────────────
  it('makeKey(canton, locale, oldSlug) returns the canton-prefixed key', () => {
    expect(makeKey('ZH', 'de', 'old-slug')).toBe('ZH::de::old-slug');
  });

  it('makeKey() puts TI in the key for legacy entries', () => {
    expect(makeKey('TI', 'it', 'old-slug')).toBe('TI::it::old-slug');
  });

  // ── Source-level guard: bridge emit + sitemap addEntry use the
  //    canton-aware section helper instead of the TI-hardcoded sectionByLocale. ──
  it('jobsSeoPagesPlugin.ts bridge emit derives section from buildCantonAwareSection', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'build-plugins', 'jobsSeoPagesPlugin.ts'),
      'utf8',
    );
    // The bridge emit region floats as the plugin grows. Locate it by the
    // unique `bridgeSection =` anchor and slice a window of surrounding lines.
    // This survives Phase 8g (cathedral hub editorial helper) and future
    // refactors that shift line numbers without changing the bridge logic.
    const lines = src.split('\n');
    const bridgeAnchorIdx = lines.findIndex((l) => /\bbridgeSection\s*=\s*buildCantonAwareSection\(/.test(l));
    expect(
      bridgeAnchorIdx,
      'expected to find `bridgeSection = buildCantonAwareSection(...)` anchor in jobsSeoPagesPlugin.ts',
    ).toBeGreaterThan(-1);
    const bridgeRegion = lines.slice(Math.max(0, bridgeAnchorIdx - 20), bridgeAnchorIdx + 80).join('\n');
    expect(bridgeRegion).toMatch(/bridgeSection\s*=\s*buildCantonAwareSection\(locale,\s*jobCantonForBridge\)/);
    const bridgeOldPathLines = bridgeRegion
      .split('\n')
      .filter((l) => /\boldPath\s*=/.test(l) && !/^\s*\/\//.test(l));
    expect(bridgeOldPathLines.length, 'expected at least one oldPath assignment in bridge emit').toBeGreaterThan(0);
    for (const l of bridgeOldPathLines) {
      expect(l, `bridge oldPath still uses sectionByLocale: ${l}`).not.toMatch(
        /sectionByLocale\[locale\]/,
      );
    }
  });

  it('jobsSeoPagesPlugin.ts sitemap addEntry for previousSlugs uses canton-aware section', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'build-plugins', 'jobsSeoPagesPlugin.ts'),
      'utf8',
    );
    // The sitemap addEntry region floats as the plugin grows. Locate it by
    // the unique `psRelPath` builder anchor and verify the canton-aware
    // section helper is used inline. Robust to Phase 8g+ line drift.
    const lines = src.split('\n');
    const psRelPathIdx = lines.findIndex((l) => /\bpsRelPath\s*=/.test(l));
    expect(
      psRelPathIdx,
      'expected to find `psRelPath =` anchor in jobsSeoPagesPlugin.ts',
    ).toBeGreaterThan(-1);
    const sitemapRegion = lines.slice(Math.max(0, psRelPathIdx - 5), psRelPathIdx + 5).join('\n');
    expect(sitemapRegion).toMatch(/psRelPath\s*=\s*`\$\{localePrefix\[locale\]\}\/\$\{buildCantonAwareSection\(/);
  });

  // ── Behavioural: when dist/ is present, every bridge file's directory
  //    should match its canonical's canton. Non-TI canton bridges must NOT
  //    live under cerca-lavoro-ticino/. We sample a handful for speed. ──
  it('non-TI canton bridges live under the canton path, not /cerca-lavoro-ticino/', () => {
    if (!fs.existsSync(DIST)) return; // offline-skip
    const jobsPath = path.join(REPO_ROOT, 'data', 'jobs.json');
    if (!fs.existsSync(jobsPath)) return;
    const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8')) as Array<{
      canton?: string;
      location?: string;
      slug?: string;
      slugByLocale?: Record<string, string>;
      previousSlugs?: string[];
      previousSlugsByLocale?: Record<string, string[]>;
    }>;
    // Find a few non-TI jobs that have previousSlugs.
    const samples = jobs
      .filter((j) => j.canton && j.canton !== 'TI')
      .filter((j) => {
        const flat = Array.isArray(j.previousSlugs) ? j.previousSlugs.length : 0;
        const byLoc = j.previousSlugsByLocale
          ? Object.values(j.previousSlugsByLocale).flat().length
          : 0;
        return flat + byLoc > 0;
      })
      .slice(0, 3);
    if (samples.length === 0) return; // no signal in dataset, skip

    const mismatches: string[] = [];
    for (const job of samples) {
      const prev = [
        ...(Array.isArray(job.previousSlugs) ? job.previousSlugs : []),
        ...Object.values(job.previousSlugsByLocale || {}).flat(),
      ];
      for (const oldSlug of prev) {
        const tiBridge = path.join(DIST, 'cerca-lavoro-ticino', oldSlug, 'index.html');
        if (fs.existsSync(tiBridge)) {
          // Verify it's actually the bridge for THIS non-TI job. The bridge file
          // has the job's canonical slug in __BRIDGE_TARGET_SLUG__.
          const html = fs.readFileSync(tiBridge, 'utf8');
          const canonicalSlug = job.slugByLocale?.it || job.slug;
          if (canonicalSlug && html.includes(canonicalSlug)) {
            mismatches.push(
              `non-TI job ${canonicalSlug} (canton=${job.canton}) bridge at TI path: cerca-lavoro-ticino/${oldSlug}/`,
            );
          }
        }
      }
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });
});
