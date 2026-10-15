/**
 * jobsJsonDistCleanupPlugin — strip redundant job-dataset monoliths from the
 * deploy artifact after all build plugins have consumed them.
 *
 * Targets:
 *   - `dist/data/jobs.json` (~88 MB) — the master crawler dataset with every
 *     job and every locale variant (`titleByLocale`, `descriptionByLocale`).
 *   - `dist/data/expired-jobs.json` (~56 MB) — the expired archive with
 *     `descriptionByLocale` ×4. Replaced at runtime by the slim
 *     `expired-jobs-index.json` + `expired-detail/<key>.json` files emitted by
 *     `expiredJobsSplitPlugin` (the SPA used to fetch this whole file, ~11 MB
 *     gz, on every navigation to an expired job). Still committed in
 *     `public/data/` (Vite copies it to `dist/`), so it must be stripped here.
 *   - `dist/data/jobs-{locale}.json` — the full per-locale shards. No longer
 *     emitted by `localeJobsSplitPlugin` (their descriptions duplicated
 *     `job-detail/<id>.json` and were never needed for listing); listed here
 *     defensively in case a stale committed copy ever sneaks into `public/`.
 *
 * Vite copies `public/` to `dist/` verbatim, so any committed copy would ship
 * to GitHub Pages / the CDN. The runtime SPA only fetches the slim indices
 * (`/data/jobs-{locale}-index.json`), per-job detail (`/data/job-detail/<id>.json`),
 * the slug map, and the expired slim index + detail — never these monoliths.
 *
 * Build-plugins that need the full datasets (jobsSeoPagesPlugin,
 * jobOgImagesPlugin, localeJobsSplitPlugin, expiredJobsSplitPlugin) read from
 * `data/*.json` or `public/data/*.json` — both upstream of `dist/`, so this
 * cleanup is invisible to them.
 *
 * Position: registered with `enforce: 'post'` so its `closeBundle` runs after
 * every other build-plugin (including expiredJobsSplitPlugin, whose slim index
 * + detail files must survive) before the artifact is uploaded.
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
   const distData = path.resolve(rootDir, 'dist', 'data');
   const targets = [
    'jobs.json',
    'expired-jobs.json',
    'jobs-it.json',
    'jobs-en.json',
    'jobs-de.json',
    'jobs-fr.json',
   ];
   for (const name of targets) {
    const target = path.resolve(distData, name);
    if (!fs.existsSync(target)) continue;
    try {
     const stat = fs.statSync(target);
     fs.unlinkSync(target);
     const mb = (stat.size / 1_048_576).toFixed(1);
     console.log(`[jobs-json-dist-cleanup] Removed dist/data/${name} (${mb} MB) — runtime fetches the slim index / per-entry detail instead.`);
    } catch (err) {
     console.warn(`[jobs-json-dist-cleanup] Failed to remove dist/data/${name}:`, err);
    }
   }
  },
 };
}
