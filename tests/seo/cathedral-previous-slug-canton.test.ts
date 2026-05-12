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
  //
  // These tests are intent-based, not name-based: they locate the code region
  // by stable anchor comments (so refactors that rename local variables don't
  // break the gate) and then assert that
  //   1. `buildCantonAwareSection(...)` is invoked in the region, and
  //   2. the call's second argument is a canton-derived variable (matches
  //      /[Jj]obCanton/ — covers `jobCantonForBridge`, `jobCantonForSitemapPrevSlugs`,
  //      and any future name that still derives the canton from the job), and
  //   3. the `oldPath` / `psRelPath` builder does NOT reference
  //      `sectionByLocale[locale]` (the legacy TI-hardcoded path — the bug
  //      this test was originally written to prevent).
  it('jobsSeoPagesPlugin.ts bridge emit derives section from buildCantonAwareSection', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'build-plugins', 'jobsSeoPagesPlugin.ts'),
      'utf8',
    );
    // Anchor the region by the bridge emit comment block. The body of the
    // bridge generator (the `for (const job of validJobs) { ... }` loop that
    // emits bridge HTML to dist/<canton-section>/<oldSlug>/index.html) lives
    // between this anchor and the next major section header.
    const bridgeAnchor = '/* ── Full-content pages for previousSlugs of active jobs';
    const anchorIdx = src.indexOf(bridgeAnchor);
    expect(anchorIdx, `bridge anchor comment missing in jobsSeoPagesPlugin.ts`).toBeGreaterThan(0);
    // End the region at the next ── header (next phase of closeBundle), e.g.
    // `/* ── Cross-locale reconciliation bridge pages ─`.
    const nextAnchorIdx = src.indexOf('/* ──', anchorIdx + bridgeAnchor.length);
    expect(nextAnchorIdx, 'expected a following ── section header to bound the bridge region').toBeGreaterThan(anchorIdx);
    const bridgeRegion = src.slice(anchorIdx, nextAnchorIdx);

    // (1) The bridge region must invoke buildCantonAwareSection with a
    // canton variable derived from the job (any name containing "JobCanton"
    // / "jobCanton"). This is the canton-aware section path.
    expect(bridgeRegion).toMatch(/buildCantonAwareSection\s*\(\s*locale\s*,\s*\w*[Jj]obCanton\w*\s*\)/);
    // (2) The oldPath builder must not fall back to the legacy TI-hardcoded
    // sectionByLocale lookup keyed by locale.
    const bridgeOldPathLines = bridgeRegion
      .split('\n')
      .filter((l) => /\boldPath\s*=/.test(l) && !/^\s*\/\//.test(l));
    expect(bridgeOldPathLines.length, 'expected at least one oldPath assignment in bridge emit').toBeGreaterThan(0);
    for (const l of bridgeOldPathLines) {
      expect(l, `bridge oldPath still uses sectionByLocale: ${l}`).not.toMatch(
        /sectionByLocale\[locale\]/,
      );
      // The line that builds oldPath must reference the canton-aware section —
      // either directly (`buildCantonAwareSection(...)`) or via a hoisted
      // variable name that itself derived from the canton-aware helper
      // (anything containing "Section" works as a heuristic so long as
      // sectionByLocale was excluded above).
      expect(l, `bridge oldPath does not appear canton-aware: ${l}`).toMatch(
        /buildCantonAwareSection|\w*[Ss]ection\b/,
      );
    }
  });

  it('jobsSeoPagesPlugin.ts sitemap addEntry for previousSlugs uses canton-aware section', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'build-plugins', 'jobsSeoPagesPlugin.ts'),
      'utf8',
    );
    // Anchor the sitemap previousSlugs region by the FRO-SEO comment that
    // introduces the bridge-sitemap-entry generation loop. The addEntry
    // closure that builds psRelPath lives within ~80 lines of this anchor.
    const sitemapAnchor = 'FRO-SEO / seo/sitemap-crawl-budget: previousSlugs bridge pages';
    const anchorIdx = src.indexOf(sitemapAnchor);
    expect(anchorIdx, `sitemap previousSlugs anchor comment missing in jobsSeoPagesPlugin.ts`).toBeGreaterThan(0);
    // Bound the region at the closing of the for-loop that hosts addEntry.
    // Use the "Legacy flat previousSlugs" comment which closes the block.
    const endMarker = 'Legacy flat previousSlugs';
    const endIdx = src.indexOf(endMarker, anchorIdx);
    expect(endIdx, 'expected "Legacy flat previousSlugs" marker after the sitemap anchor').toBeGreaterThan(anchorIdx);
    const sitemapRegion = src.slice(anchorIdx, endIdx);

    // (1) The psRelPath builder (or its functional equivalent under another
    // local name) must call buildCantonAwareSection with the job-derived
    // canton variable as the second argument.
    expect(sitemapRegion).toMatch(
      /\w*Path\s*=\s*`\$\{localePrefix\[locale\]\}\/\$\{buildCantonAwareSection\(\s*locale\s*,\s*\w*[Jj]obCanton\w*\s*\)\}\/\$\{[^`]+`/,
    );
    // (2) Defence-in-depth: no occurrence of sectionByLocale[locale] inside
    // the sitemap previousSlugs region — that's the legacy TI-hardcode the
    // canton-aware refactor replaced.
    expect(sitemapRegion).not.toMatch(/sectionByLocale\[locale\]/);
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
