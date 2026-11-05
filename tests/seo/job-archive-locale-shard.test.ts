import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JOBS_PAGE_SIZE } from '../../build-plugins/seoHubsData';
import { writeAllKnownJobSlugs } from '../../scripts/lib/all-known-job-slugs-store.mjs';

describe('job archive pagination in locale-shard builds', () => {
  it('counts foreign-locale fallback details the renderer preserves', async () => {
    const previousBuildLocale = process.env.BUILD_LOCALE;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-archive-locale-shard-'));
    try {
      process.env.BUILD_LOCALE = 'en';
      vi.resetModules();
      const { countEmittedJobArchivePagesByLocale } = await import('../../build-plugins/seoHubsPlugin');
      const distDir = path.join(root, 'dist');
      fs.mkdirSync(distDir, { recursive: true });

      const itPages = Object.fromEntries(Array.from({ length: JOBS_PAGE_SIZE + 1 }, (_, index) => {
        const slug = `foreign-fallback-${index}`;
        return [slug, `/cerca-lavoro-ticino/${slug}/`];
      }));
      const registry = Object.fromEntries(Object.entries(itPages).map(([slug, href]) => [slug, { it: href }]));
      writeAllKnownJobSlugs(registry, root);

      const pagesByLocale = countEmittedJobArchivePagesByLocale(fs, path, root, distDir);

      // The renderer has the same 101 fallback items: its shared inventory
      // treats `/it/...` as owned by the IT shard, even though this EN dist
      // correctly contains no corresponding files.
      expect(pagesByLocale.en).toBe(Math.ceil(Object.keys(itPages).length / JOBS_PAGE_SIZE));
      expect(pagesByLocale.en).toBe(2);
    } finally {
      if (previousBuildLocale === undefined) delete process.env.BUILD_LOCALE;
      else process.env.BUILD_LOCALE = previousBuildLocale;
      vi.resetModules();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
