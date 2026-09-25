import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import {
  buildSlimExpiredEntry,
  makeExpiredKeyAssigner,
} from './shared/slimExpiredIndex';

/**
 * Splits the aggregated `data/expired-jobs.json` archive into:
 *   - `dist/data/expired-jobs-index.json` — slim index (no descriptionByLocale)
 *   - `dist/data/expired-detail/<key>.json` — full per-entry detail
 *
 * Replaces the single ~56MB / ~11MB-gz file the SPA used to fetch whole on
 * every navigation to an expired job (hooks/useExpiredJob.ts). Build-time
 * consumers (jobsSeoPagesPlugin seeding window.__EXPIRED_JOB_DATA__) keep
 * reading `data/expired-jobs.json` directly and are unaffected.
 *
 * Mirrors localeJobsSplitPlugin's emit contract (apply:'build', closeBundle for
 * dist + configureServer for the dev server).
 */
export function expiredJobsSplitPlugin(rootDir: string): Plugin {
  const expiredJobsPath = path.resolve(rootDir, 'data', 'expired-jobs.json');

  function generateFiles(outDir: string): number {
    if (!fs.existsSync(expiredJobsPath)) return 0;
    let entries: Record<string, unknown>[];
    try {
      entries = JSON.parse(fs.readFileSync(expiredJobsPath, 'utf-8'));
    } catch {
      return 0;
    }
    if (!Array.isArray(entries)) return 0;

    const dataDir = path.resolve(outDir, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const detailDir = path.resolve(dataDir, 'expired-detail');
    if (!fs.existsSync(detailDir)) fs.mkdirSync(detailDir, { recursive: true });

    const assignKey = makeExpiredKeyAssigner();
    const slimIndex: Record<string, unknown>[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const key = assignKey(entry.slug as string | undefined);
      fs.writeFileSync(
        path.resolve(detailDir, `${key}.json`),
        JSON.stringify(entry),
        'utf-8',
      );
      slimIndex.push(buildSlimExpiredEntry(entry, key));
    }

    fs.writeFileSync(
      path.resolve(dataDir, 'expired-jobs-index.json'),
      JSON.stringify(slimIndex),
      'utf-8',
    );
    return slimIndex.length;
  }

  return {
    name: 'expired-jobs-split',
    apply: 'build',
    closeBundle() {
      const distDir = path.resolve(rootDir, 'dist');
      const count = generateFiles(distDir);
      if (count > 0) {
        console.log(`[expired-jobs-split] Generated slim index + ${count} detail files`);
      }
    },
    configureServer() {
      // In dev, emit to public/data/ so the dev server can serve them.
      const publicDir = path.resolve(rootDir, 'public');
      const count = generateFiles(publicDir);
      if (count > 0) {
        console.log(`[expired-jobs-split] Dev: generated slim index + ${count} detail files in public/data/`);
      }
    },
  };
}
