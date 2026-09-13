import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pharmacyDirectoryPagesPlugin, pharmacyPageDescriptors, pharmacyUrlAliasDescriptors } from '../build-plugins/pharmacyDirectoryPagesPlugin';
import { AD_SLOTS } from '../services/adsenseSlots';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacy-directory-pages-'));
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'sitemap.xml'), '<sitemapindex></sitemapindex>');
  tempRoots.push(root);
  return root;
}

function runCloseBundle(root: string): Promise<void> {
  return (pharmacyDirectoryPagesPlugin(root) as unknown as {
    closeBundle: () => Promise<void>;
  }).closeBundle();
}

function pageFiles(distDir: string): string[] {
  return (fs.readdirSync(distDir, { recursive: true }) as string[])
    .filter((entry) => entry.endsWith('index.html'));
}

function routeForPageFile(file: string): string {
  return `/${file.replace(/\\/g, '/').replace(/\/index\.html$/, '')}/`;
}

function robotsOf(html: string): string {
  return /<meta name=["']?robots["']? content=["']?((?:no)?index,\s*follow)/i.exec(html)?.[1] ?? '';
}

describe('pharmacy directory static pages', () => {
  it('keeps below-floor routes out of the sitemap at the source boundary', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', 'build-plugins', 'pharmacyDirectoryPagesPlugin.ts'),
      'utf8',
    );
    expect(source).toContain('const indexable = descriptor.kind !== \'duty-city\' && wordCount >= MIN_INDEXABLE_WORDS;');
    expect(source).toContain('if (built.indexable) urls.push(built.path);');
    expect(source).toContain('let excludedNoindexRoutes = 0;');
    expect(source).toContain('else excludedNoindexRoutes += 1;');
  });

  it('keeps HTML, robots, sitemap and end-of-content ads on one indexability contract', async () => {
    const root = makeTempRoot();
    await runCloseBundle(root);

    const distDir = path.join(root, 'dist');
    const pages = pageFiles(distDir);
    const expectedPageCount = 4 * pharmacyPageDescriptors().length + pharmacyUrlAliasDescriptors().length;
    expect(pages).toHaveLength(expectedPageCount);

    const sitemap = fs.readFileSync(path.join(distDir, 'sitemap-farmacie.xml'), 'utf8');
    const sitemapRoutes = new Set(
      [...sitemap.matchAll(/<loc>[^<]+<\/loc>/g)].map((match) => new URL(match[0].slice(5, -6)).pathname),
    );
    expect(sitemapRoutes.size).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(distDir, 'sitemap.xml'), 'utf8'))
      .toContain('sitemap-farmacie.xml');

    let indexableCount = 0;
    let noindexCount = 0;
    for (const file of pages) {
      const html = fs.readFileSync(path.join(distDir, file), 'utf8');
      const robots = robotsOf(html);
      const normalizedRobots = robots.replace(/\s+/g, '').toLowerCase();
      const route = routeForPageFile(file);
      if (normalizedRobots === 'index,follow') {
        indexableCount += 1;
        expect(sitemapRoutes.has(route), route).toBe(true);
        expect(html).toContain(`data-ad-slot=${AD_SLOTS.SSG_END_MULTIPLEX.slot}`);
      } else {
        expect(normalizedRobots, `${file} robots=${robots}`).toBe('noindex,follow');
        noindexCount += 1;
        expect(sitemapRoutes.has(route), `${route} must not be sitemapped`).toBe(false);
        expect(html).not.toContain(`data-ad-slot=${AD_SLOTS.SSG_END_MULTIPLEX.slot}`);
      }
    }

    expect(indexableCount + noindexCount).toBe(expectedPageCount);
    expect(indexableCount).toBe(sitemapRoutes.size);
  });
});
