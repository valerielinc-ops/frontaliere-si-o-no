/**
 * soft404-sitemap-discovery.mjs
 *
 * Single source of truth for the sitemap population the soft-404 gate judges.
 *
 * Why this exists
 * ---------------
 * `validate-soft404.mjs` used to enumerate `public/`, not `dist/` — but `public/`
 * only holds the ten sitemaps that are checked into the repo. Every sitemap
 * emitted by a build plugin (`sitemap-eventi.xml` from `eventsSeoPagesPlugin`,
 * `sitemap-comuni-germania.xml`, `sitemap-comuni-liechtenstein.xml`, …) is
 * written straight into `distDir` and therefore never existed in the population.
 * The gate reported "10 sitemaps" and a green tick while checking zero URLs of
 * the whole events tree, ladder pages included (issue #7744).
 *
 * `dist/` is what gets served: Vite copies `public/` into it, so enumerating
 * `dist/` is a strict superset of the old population, never a narrower one.
 *
 * The job exclusion has to widen with it
 * --------------------------------------
 * The old filter dropped the single literal `sitemap-jobs.xml`, the only job
 * sitemap that exists in `public/`. In `dist/` the job board is sharded across
 * `sitemap-jobs-001.xml`, `sitemap-jobs-ticino.xml`, `sitemap-jobs-expired.xml`
 * and ~30 more. Those pages play by different rules — the expired shard lists
 * `noindex` archive pages *by design*, which is exactly what soft-404 Rule 4
 * calls an error — so the exclusion is the same intent expressed as a prefix.
 *
 * Sitemap *indexes* are dropped too: their `<loc>`s point at other `.xml`
 * files, not at pages, so every one of them would count as a missing file.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

/** Job sitemaps are excluded: job pages have their own validators and rules. */
export function isJobSitemap(file) {
  return file === 'sitemap-jobs.xml' || file.startsWith('sitemap-jobs-');
}

/** A `<sitemapindex>` lists sitemaps, not pages — it has no URLs to judge. */
export function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(xml);
}

/**
 * Enumerate the sitemaps the soft-404 gate must inspect, from what is served.
 *
 * @param {string} rootDir repository root
 * @returns {{ dir: string, files: string[], excluded: string[] }}
 *   `dir` is the directory actually enumerated, `files` the sitemaps to judge,
 *   `excluded` the `sitemap-*.xml` siblings skipped on purpose (job shards and
 *   sitemap indexes) — printed by the callers so a silent hole stays visible.
 */
export function discoverSoft404Sitemaps(rootDir) {
  const distDir = path.join(rootDir, 'dist');
  // Fall back to public/ only when there is no build to judge (unit tests, a
  // clean checkout): the gate is post-build, and dist/ is the served truth.
  const dir = existsSync(distDir) ? distDir : path.join(rootDir, 'public');
  if (!existsSync(dir)) return { dir, files: [], excluded: [] };

  const candidates = readdirSync(dir)
    .filter(f => f.startsWith('sitemap-') && f.endsWith('.xml'))
    .sort();

  const files = [];
  const excluded = [];
  for (const file of candidates) {
    if (isJobSitemap(file)) {
      excluded.push(file);
      continue;
    }
    if (isSitemapIndex(readFileSync(path.join(dir, file), 'utf-8'))) {
      excluded.push(file);
      continue;
    }
    files.push(file);
  }
  return { dir, files, excluded };
}
