// The `/tutti/` archive must list newest-first.
//
// It used to list in the order `masterSlugs` happened to be filled — meta chunk
// then slug map, i.e. the order articles were APPENDED. With 3074 articles at
// 100 per page that put every new article on page 31, and only page 1 is in the
// sitemap: the rest hangs off the pagination chain alone, so a freshly
// published article sat ~31 hops from anything linking to it. Measured on the
// live shard before the fix: page 1 opened with `stipendio-netto-frontaliere-2026`
// (2026-01-15) while articles from 2026-08-04 were live and unlisted.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { emitSeoHubs } from '../build-plugins/seoHubsPlugin';
import { resolveSpaBundle } from '../build-plugins/spaBundleResolver';

const rootDir = process.cwd();

/** id → date, straight from the registry the emitter reads. */
function registryDates(registryFile: string): Map<string, string> {
  const src = fs.readFileSync(path.join(rootDir, registryFile), 'utf-8');
  const out = new Map<string, string>();
  const rx = /\{\s*id:\s*'([^']+)',\s*category:\s*'[^']*',\s*date:\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(src)) !== null) out.set(m[1], m[2]);
  return out;
}

describe('article archive ordering', () => {
  let distDir: string;

  beforeAll(() => {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-order-'));
    const { entryJs, entryCss, hasSpaBundle } = resolveSpaBundle(distDir);
    emitSeoHubs({
      rootDir,
      distDir,
      fs,
      np: path,
      qw: (filePath: string, content: string) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf-8');
      },
      sitemapEntries: [],
      dateStamp: '2026-08-04',
      entryJs,
      entryCss,
      hasSpaBundle,
    } as Parameters<typeof emitSeoHubs>[0]);
  });

  afterAll(() => {
    if (distDir) fs.rmSync(distDir, { recursive: true, force: true });
  });

  for (const [section, archivePath, registryFile] of [
    ['frontaliere', 'articoli-frontaliere/tutti/index.html', 'data/blog-articles-data.ts'],
    ['svizzera', 'articoli-svizzera/tutti/index.html', 'data/swiss-articles-data.ts'],
  ] as const) {
    it(`lists ${section} newest-first on page 1`, () => {
      const html = fs.readFileSync(path.join(distDir, archivePath), 'utf-8');
      const slugs = [...html.matchAll(/href="\/articoli-[a-z]+\/([a-z0-9-]+)\/"/g)].map((m) => m[1]);
      expect(slugs.length).toBeGreaterThan(10);

      const dates = registryDates(registryFile);
      // Page 1 is IT, where slug === id for the vast majority; entries the
      // registry has no date for are the "sorts last" case and are skipped
      // rather than asserted on.
      const seen = slugs.map((s) => dates.get(s)).filter((d): d is string => Boolean(d));
      expect(seen.length).toBeGreaterThan(10);

      const sorted = [...seen].sort((a, b) => b.localeCompare(a));
      expect(seen).toEqual(sorted);
    });

    it(`puts the newest ${section} article on page 1, not the last page`, () => {
      const html = fs.readFileSync(path.join(distDir, archivePath), 'utf-8');
      const dates = registryDates(registryFile);
      const newestId = [...dates.entries()].sort((a, b) => b[1].localeCompare(a[1]))[0][0];
      expect(html).toContain(`/${newestId}/`);
    });
  }
});
