/**
 * #4593 regression test: mineActiveJobs()/mineExpiredJobs()'s "Main slug"
 * (and "Previous slugs") branches used to resolve a job's real cantonCode
 * but apply it to only the `it` locale path, leaving en/de/fr unset. Those
 * empty locales then fell through to a hardcoded-TI last-resort default
 * elsewhere in main(), so tracking entries for non-TI jobs ended up with a
 * correct `it` path but en/de/fr still pointing at the legacy TI board.
 *
 * The fix centralizes locale-filling into `fillMissingLocalePaths`, now used
 * by both mining functions' "Main slug"/"Previous slugs" branches. This test
 * exercises that shared helper (and its `buildLocalePathsForCanton` base)
 * directly — the exact logic both branches call — rather than the full
 * `main()` pipeline, which is unsafe to invoke in a test (it mutates real
 * repo data files by design and has no dependency-injection seam for its
 * `ROOT`-derived paths). The module is guarded so importing it here does not
 * trigger that real pipeline as a side effect (see the
 * `process.argv[1] === fileURLToPath(import.meta.url)` guard around `main()`
 * in mine-all-job-slugs.mjs).
 */
import { describe, expect, it } from 'vitest';
import {
  buildLocalePathsForCanton,
  buildLocalePathsForJob,
  fillMissingLocalePaths,
} from '../scripts/mine-all-job-slugs.mjs';

describe('buildLocalePathsForCanton — base resolver (#4593 sanity)', () => {
  it('resolves all 4 locales to a non-TI canton section for a resolvable canton', () => {
    const slug = 'software-engineer-acme-zurich';
    const paths = buildLocalePathsForCanton('ZH', slug);
    expect(paths.it).toContain(slug);
    expect(paths.en).toContain(slug);
    expect(paths.de).toContain(slug);
    expect(paths.fr).toContain(slug);
    // None of the 4 should still be on the legacy Ticino section for a ZH job.
    expect(paths.it).not.toMatch(/ticino|tessin/i);
    expect(paths.en).not.toMatch(/ticino|tessin/i);
    expect(paths.de).not.toMatch(/ticino|tessin/i);
    expect(paths.fr).not.toMatch(/ticino|tessin/i);
  });
});

describe('fillMissingLocalePaths — #4593 fix', () => {
  it('fills ALL 4 locales from cantonCode when the entry starts empty (Main slug branch shape)', () => {
    const slug = 'software-engineer-acme-zurich';
    const entry = { locales: {} };
    fillMissingLocalePaths(entry, 'ZH', slug);

    expect(Object.keys(entry.locales).sort()).toEqual(['de', 'en', 'fr', 'it']);
    for (const l of ['it', 'en', 'de', 'fr'] as const) {
      expect(entry.locales[l], `locale ${l} should not be empty`).toBeTruthy();
      expect(entry.locales[l]).not.toMatch(/ticino|tessin/i);
    }
  });

  it('does NOT overwrite a locale that is already set (preserves fuzzy-matched/explicit paths)', () => {
    const slug = 'software-engineer-acme-zurich';
    const entry = { locales: { it: '/custom-preserved-path/' } };
    fillMissingLocalePaths(entry, 'ZH', slug);

    expect(entry.locales.it).toBe('/custom-preserved-path/');
    expect(entry.locales.en).toBeTruthy();
    expect(entry.locales.de).toBeTruthy();
    expect(entry.locales.fr).toBeTruthy();
  });

  it('reproduces the exact reported symptom being fixed: en/de/fr no longer stuck on TI once cantonCode resolves', () => {
    const slug = 'polymechaniker-acme-luzern';
    const entry = { locales: {} };
    fillMissingLocalePaths(entry, 'LU', slug);

    // Before the fix, only `it` would have been set here, and a caller's
    // last-resort default would have back-filled en/de/fr with
    // buildLocalePathsForCanton('TI', slug) — i.e. the legacy TI board.
    const tiPaths = buildLocalePathsForCanton('TI', slug);
    expect(entry.locales.en).not.toBe(tiPaths.en);
    expect(entry.locales.de).not.toBe(tiPaths.de);
    expect(entry.locales.fr).not.toBe(tiPaths.fr);
  });
});

describe('buildLocalePathsForJob — thin wrapper used by fuzzy-match recovery', () => {
  it('resolves canton from job.canton/job.location and builds all 4 locale paths', () => {
    const job = { canton: 'ZH', location: 'Zürich' };
    const paths = buildLocalePathsForJob(job, 'software-engineer-acme-zurich');
    expect(paths.it).toBeTruthy();
    expect(paths.en).toBeTruthy();
    expect(paths.de).toBeTruthy();
    expect(paths.fr).toBeTruthy();
  });
});
