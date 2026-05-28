/**
 * jobsJsonDistCleanupPlugin — strip the 88 MB master `dist/data/jobs.json`
 * from the deploy artifact after all build plugins have consumed it.
 *
 * Why: `public/data/jobs.json` is the master crawler dataset with every job
 * and every locale variant (`titleByLocale`, `descriptionByLocale`, etc.).
 * Vite copies `public/` to `dist/` verbatim, so the master would ship to
 * GitHub Pages even though the runtime SPA only ever fetches the locale-
 * flattened shards (`/data/jobs-{locale}.json`, ~24 MB each) and the
 * `/data/jobs-slug-map.json` (5 MB). Dropping the master from `dist/`
 * frees ~88 MB on the deploy artifact (we are bumping against the 10 GB
 * GitHub Pages cap).
 *
 * Build-plugins that need the full dataset (jobsSeoPagesPlugin,
 * jobOgImagesPlugin, localeJobsSplitPlugin, etc.) read from `data/jobs.json`
 * or `public/data/jobs.json` — both upstream of `dist/`, so this cleanup
 * is invisible to them.
 *
 * Position: registered with `enforce: 'post'` so its `closeBundle` runs
 * after every other build-plugin that might still need `dist/data/jobs.json`
 * (none today, but future plugins reading from the dist copy would be
 * caught here in CI before the artifact is uploaded).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

export function jobsJsonDistCleanupPlugin(rootDir: string): Plugin {
 return {
  name: 'jobs-json-dist-cleanup',
  apply: 'build',
  enforce: 'post',
  closeBundle() {
   const target = path.resolve(rootDir, 'dist', 'data', 'jobs.json');
   if (!fs.existsSync(target)) return;
   try {
    const stat = fs.statSync(target);
    fs.unlinkSync(target);
    const mb = (stat.size / 1_048_576).toFixed(1);
    console.log(`[jobs-json-dist-cleanup] Removed dist/data/jobs.json (${mb} MB) — runtime fetches the per-locale shards instead.`);
   } catch (err) {
    console.warn('[jobs-json-dist-cleanup] Failed to remove dist/data/jobs.json:', err);
   }
  },
 };
}
