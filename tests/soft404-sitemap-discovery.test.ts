/**
 * The soft-404 gate must judge every sitemap that is actually served.
 *
 * `validate-soft404.mjs` enumerated `public/`, which holds only the ten
 * checked-in sitemaps. Every sitemap written by a build plugin — first among
 * them `sitemap-eventi.xml` from `eventsSeoPagesPlugin` — lands in `dist/` and
 * in nothing else, so it was never part of the population: the gate printed
 * "10 sitemaps" and a green tick while checking zero URLs of the whole events
 * tree, ladder pages included (issue #7744). A sitemap that is served and not
 * inspected is a hole, and the hole reopens the moment somebody adds another
 * plugin-generated sitemap.
 *
 * These tests pin the invariant rather than the file list: whatever `dist/`
 * serves is inspected, minus the two exclusions that are deliberate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  discoverSoft404Sitemaps,
  isJobSitemap,
  isSitemapIndex,
} from '../scripts/lib/soft404-sitemap-discovery.mjs';

const urlset = (loc: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${loc}</loc></url>\n</urlset>\n`;

const sitemapindex = (loc: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <sitemap><loc>${loc}</loc></sitemap>\n</sitemapindex>\n`;

let root: string;

function write(dir: string, file: string, xml: string) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, file), xml, 'utf-8');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'soft404-discovery-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('discoverSoft404Sitemaps', () => {
  it('inspects every sitemap-*.xml dist/ serves, not just the ones in public/', () => {
    write('public', 'sitemap-pages.xml', urlset('https://frontaliereticino.ch/'));
    write('dist', 'sitemap-pages.xml', urlset('https://frontaliereticino.ch/'));
    // Written by eventsSeoPagesPlugin straight into distDir — the regression.
    write('dist', 'sitemap-eventi.xml', urlset('https://frontaliereticino.ch/eventi/'));

    const { dir, files } = discoverSoft404Sitemaps(root);

    expect(dir).toBe(path.join(root, 'dist'));
    expect(files).toContain('sitemap-eventi.xml');
  });

  it('leaves no served sitemap uninspected: files + excluded covers all of dist/', () => {
    write('dist', 'sitemap-pages.xml', urlset('https://frontaliereticino.ch/'));
    write('dist', 'sitemap-eventi.xml', urlset('https://frontaliereticino.ch/eventi/'));
    write('dist', 'sitemap-comuni-germania.xml', urlset('https://frontaliereticino.ch/comuni/'));
    write('dist', 'sitemap-jobs-001.xml', urlset('https://frontaliereticino.ch/lavoro/a/'));
    write('dist', 'sitemap-index.xml', sitemapindex('https://frontaliereticino.ch/sitemap-pages.xml'));

    const { files, excluded } = discoverSoft404Sitemaps(root);

    const served = fs
      .readdirSync(path.join(root, 'dist'))
      .filter(f => f.startsWith('sitemap-') && f.endsWith('.xml'))
      .sort();
    expect([...files, ...excluded].sort()).toEqual(served);
  });

  it('excludes every job shard, not just the literal sitemap-jobs.xml', () => {
    write('dist', 'sitemap-jobs.xml', urlset('https://frontaliereticino.ch/lavoro/'));
    write('dist', 'sitemap-jobs-001.xml', urlset('https://frontaliereticino.ch/lavoro/a/'));
    write('dist', 'sitemap-jobs-ticino.xml', urlset('https://frontaliereticino.ch/lavoro/b/'));
    // The expired shard lists noindex archive pages by design — soft-404 Rule 4
    // would call every one of them an error.
    write('dist', 'sitemap-jobs-expired.xml', urlset('https://frontaliereticino.ch/lavoro/c/'));
    write('dist', 'sitemap-eventi.xml', urlset('https://frontaliereticino.ch/eventi/'));

    const { files } = discoverSoft404Sitemaps(root);

    expect(files).toEqual(['sitemap-eventi.xml']);
  });

  it('excludes sitemap indexes, whose locs point at sitemaps and not at pages', () => {
    write('dist', 'sitemap-index.xml', sitemapindex('https://frontaliereticino.ch/sitemap-pages.xml'));
    write('dist', 'sitemap-pages.xml', urlset('https://frontaliereticino.ch/'));

    const { files, excluded } = discoverSoft404Sitemaps(root);

    expect(files).toEqual(['sitemap-pages.xml']);
    expect(excluded).toEqual(['sitemap-index.xml']);
  });

  it('falls back to public/ when there is no build to judge', () => {
    write('public', 'sitemap-pages.xml', urlset('https://frontaliereticino.ch/'));

    const { dir, files } = discoverSoft404Sitemaps(root);

    expect(dir).toBe(path.join(root, 'public'));
    expect(files).toEqual(['sitemap-pages.xml']);
  });

  it('returns an empty population instead of throwing on a bare checkout', () => {
    expect(discoverSoft404Sitemaps(root)).toEqual({
      dir: path.join(root, 'public'),
      files: [],
      excluded: [],
    });
  });
});

describe('exclusion predicates', () => {
  it('isJobSitemap matches the job family and nothing that merely starts alike', () => {
    expect(isJobSitemap('sitemap-jobs.xml')).toBe(true);
    expect(isJobSitemap('sitemap-jobs-001.xml')).toBe(true);
    expect(isJobSitemap('sitemap-job-market.xml')).toBe(false);
    expect(isJobSitemap('sitemap-eventi.xml')).toBe(false);
  });

  it('isSitemapIndex distinguishes an index from a urlset', () => {
    expect(isSitemapIndex(sitemapindex('https://frontaliereticino.ch/sitemap-pages.xml'))).toBe(true);
    expect(isSitemapIndex(urlset('https://frontaliereticino.ch/'))).toBe(false);
  });
});
