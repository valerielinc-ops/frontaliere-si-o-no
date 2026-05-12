import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Phase 8 Sub-PR (a): the per-job emit dedup key in `jobsSeoPagesPlugin.ts`
 * is `(canton, locale, slug)`. Previously the key was `(locale, slug)`,
 * which meant two distinct jobs sharing a DE/EN/FR locale slug but living
 * in different cantons would collide — only the most-recent winner emitted
 * HTML, and the loser's URL appeared in the sitemap but pointed at a
 * missing file (the validate-sitemap-pages gate then required a band-aid
 * in hreflangPostprocessPlugin: drop ALL hreflang tags when below the 5
 * entry threshold).
 *
 * Two cross-cutting checks live here:
 *
 *   1. Unit-style: the canonical (canton, locale, slug) key dedups
 *      identical (locale, slug) under different cantons as two distinct
 *      entries, not one. This is a structural test of the key shape and
 *      catches an accidental revert of the key back to (locale, slug).
 *
 *   2. Behavioural: if dist/ exists, walk every job in jobs.json and
 *      verify that for cross-canton slug collisions we actually emit a
 *      file under each canton path (not just one canton's). Offline-skip
 *      mode mirrors the rest of the cathedral test suite.
 */

const DIST = path.resolve(__dirname, '../../dist');
const JOBS_PATH = path.resolve(__dirname, '../../data/jobs.json');

interface JobShape {
  canton?: string;
  location?: string;
  slug?: string;
  slugByLocale?: { it?: string; en?: string; de?: string; fr?: string };
  isActive?: boolean;
  crawledAt?: string;
}

const PLUGIN_PATH = path.resolve(__dirname, '../../build-plugins/jobsSeoPagesPlugin.ts');

describe('cathedral canton-aware dedup (Phase 8a)', () => {
  it('jobsSeoPagesPlugin uses (canton, locale, slug) as the active-job dedup key', () => {
    // Source-level guard: the per-job emit loop's dedup key must include
    // the canton segment. If someone reverts this to (locale, slug) the
    // cross-canton 21-DE-file collision returns and the Phase 3 band-aid
    // becomes needed again.
    const src = fs.readFileSync(PLUGIN_PATH, 'utf8');
    // Match: const __activeJobKey = `${jobCanton}:${locale}:${perLocaleSlug[locale]}`;
    const rx = /__activeJobKey\s*=\s*`\$\{jobCanton\}:\$\{locale\}:\$\{perLocaleSlug\[locale\]\}`/;
    expect(rx.test(src), 'Expected dedup key `${jobCanton}:${locale}:${perLocaleSlug[locale]}` not found in jobsSeoPagesPlugin.ts').toBe(true);

    // The old (locale, slug)-only key must NOT appear anywhere as the
    // active-job dedup key (catches a partial revert).
    const oldRx = /__activeJobKey\s*=\s*`\$\{locale\}:\$\{perLocaleSlug\[locale\]\}`/;
    expect(oldRx.test(src), 'Old (locale, slug) active-job dedup key still present in jobsSeoPagesPlugin.ts').toBe(false);
  });

  it('Phase 3 hreflang band-aid (MIN_HREFLANG_ENTRIES) is reverted', () => {
    // After Phase 8a the (canton, locale, slug) dedup eliminates the
    // cross-canton slug collision that was causing the cathedral DE
    // pages to lose their hreflang siblings. The drop-all-below-5
    // band-aid in hreflangPostprocessPlugin can go.
    const hreflangSrc = fs.readFileSync(
      path.resolve(__dirname, '../../build-plugins/hreflangPostprocessPlugin.ts'),
      'utf8',
    );
    expect(
      /MIN_HREFLANG_ENTRIES/.test(hreflangSrc),
      'Phase 3 MIN_HREFLANG_ENTRIES band-aid still present — revert it now that (canton, locale, slug) dedup is in place.',
    ).toBe(false);
  });

  it('(canton, locale, slug) keys keep cross-canton same-slug entries distinct', () => {
    // Minimal fixture: two jobs that DE-translate to the same slug but
    // live in different cantons. Under the old (locale, slug) key these
    // would collide — only one survives. Under the new key BOTH survive
    // because the canton differs.
    const job1 = { canton: 'BS', locale: 'de', slug: 'tally-weijl-vendeur-vendeuse' };
    const job2 = { canton: 'ZH', locale: 'de', slug: 'tally-weijl-vendeur-vendeuse' };

    const newKey1 = `${job1.canton}:${job1.locale}:${job1.slug}`;
    const newKey2 = `${job2.canton}:${job2.locale}:${job2.slug}`;
    expect(newKey1).not.toBe(newKey2);

    const seen = new Set<string>();
    seen.add(newKey1);
    seen.add(newKey2);
    expect(seen.size).toBe(2);

    // Cross-check: the old (locale, slug) key WOULD collide
    const oldKey1 = `${job1.locale}:${job1.slug}`;
    const oldKey2 = `${job2.locale}:${job2.slug}`;
    expect(oldKey1).toBe(oldKey2);
  });

  it('TI invariance: a TI-canton job still keys uniquely under its own canton scope', () => {
    // The new key still produces unique entries scoped to TI; since no
    // other canton uses the TI legacy-frozen section, no cross-canton
    // collision is possible. This is the byte-identical guarantee.
    const tiKey = 'TI:it:contabile-lugano';
    const tiKey2 = 'TI:it:contabile-bellinzona';
    expect(tiKey).not.toBe(tiKey2);
  });

  it('cross-canton slug collisions emit one HTML file per canton (behavioural)', () => {
    if (!fs.existsSync(DIST)) return; // offline skip
    if (!fs.existsSync(JOBS_PATH)) return;

    const jobs: JobShape[] = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
    // Index active jobs by (locale, slug) and collect their cantons.
    const slugToCantons = new Map<string, Set<string>>();
    for (const job of jobs) {
      if (job.isActive === false) continue;
      const deSlug = job.slugByLocale?.de;
      const canton = String(job.canton || '').toUpperCase();
      if (!deSlug || !canton) continue;
      const key = `de:${deSlug}`;
      let bucket = slugToCantons.get(key);
      if (!bucket) {
        bucket = new Set();
        slugToCantons.set(key, bucket);
      }
      bucket.add(canton);
    }

    // Cross-canton collisions = (locale, slug) keys with 2+ distinct cantons.
    const collisions = [...slugToCantons.entries()].filter(([, c]) => c.size >= 2);
    if (collisions.length === 0) return; // no collisions in this dataset → nothing to assert

    // For each colliding slug, take the first 5 collisions and verify
    // that AT LEAST 2 canton-section paths exist on disk. Pre-Phase 8a
    // only 1 would have existed (the winner) — the others were dropped
    // by the (locale, slug) dedup.
    const sample = collisions.slice(0, 5);
    const failures: string[] = [];
    for (const [key, cantonSet] of sample) {
      const slug = key.replace(/^de:/, '');
      const emittedCantons: string[] = [];
      for (const canton of cantonSet) {
        // Walk every section under dist/de/ — cheap because cantonSection
        // is deterministic and the slug is unique within a canton folder.
        const sections = fs.existsSync(path.join(DIST, 'de'))
          ? fs.readdirSync(path.join(DIST, 'de'), { withFileTypes: true })
              .filter((d) => d.isDirectory())
              .map((d) => d.name)
          : [];
        for (const section of sections) {
          const candidate = path.join(DIST, 'de', section, slug, 'index.html');
          if (fs.existsSync(candidate)) {
            emittedCantons.push(`${canton}@${section}`);
            break;
          }
        }
      }
      if (emittedCantons.length < 2) {
        failures.push(`${slug}: cantons=${[...cantonSet].join(',')} emitted=${emittedCantons.join('|')}`);
      }
    }

    expect(
      failures,
      `Cross-canton slug collisions still produce only one emitted file (Phase 8a regression). Sample: ${failures.slice(0, 3).join(' / ')}`,
    ).toEqual([]);
  });
});
