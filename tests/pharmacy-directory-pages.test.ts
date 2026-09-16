import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPharmacyDirectoryPage, pharmacyDirectoryPagesPlugin, pharmacyPageDescriptors, pharmacyUrlAliasDescriptors } from '../build-plugins/pharmacyDirectoryPagesPlugin';
import { AD_SLOTS } from '../services/adsenseSlots';
import catalogueJson from '../data/pharmacies-ticino-complete.json';
import dutiesJson from '../data/pharmacy-duties-ticino.json';
import type { PharmacyDutiesDataset } from '../services/pharmacies/types';

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
  it('keeps duty-week model indexability fail-closed and tied to the sitemap', async () => {
    const root = makeTempRoot();
    await runCloseBundle(root);

    const descriptor = pharmacyPageDescriptors().find((candidate) => candidate.kind === 'duty-week');
    const hubDescriptor = pharmacyPageDescriptors().find((candidate) => candidate.kind === 'duty-hub');
    expect(descriptor).toBeDefined();
    expect(hubDescriptor).toBeDefined();
    const now = new Date(Math.max(Date.parse(dutiesJson._fetchedAt), Date.parse(catalogueJson._fetchedAt)) + 60_000);
    const current = buildPharmacyDirectoryPage(descriptor!, 'it', root, dutiesJson as unknown as PharmacyDutiesDataset, now);
    const nextWeek = new Date(`${descriptor!.weekStart}T00:00:00Z`);
    nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);
    const validDescriptor = { ...descriptor!, weekStart: nextWeek.toISOString().slice(0, 10) };
    const valid = buildPharmacyDirectoryPage(validDescriptor, 'it', root, dutiesJson as unknown as PharmacyDutiesDataset, now);
    expect(valid.indexable).toBe(true);
    expect(robotsOf(valid.html).replace(/\s+/g, '')).toBe('index,follow');
    expect(valid.html).toContain('"@type":"ItemList"');

    const hub = buildPharmacyDirectoryPage(hubDescriptor!, 'it', root, dutiesJson as unknown as PharmacyDutiesDataset, now);
    expect(hub.indexable).toBe(true);
    expect(robotsOf(hub.html).replace(/\s+/g, '')).toBe('index,follow');
    expect(hub.html).toContain('"@type":"ItemList"');

    const sitemap = fs.readFileSync(path.join(root, 'dist', 'sitemap-farmacie.xml'), 'utf8');
    const sitemapRoutes = new Set(
      [...sitemap.matchAll(/<loc>[^<]+<\/loc>/g)].map((match) => new URL(match[0].slice(5, -6)).pathname),
    );
    expect(sitemapRoutes.has(current.path)).toBe(current.indexable);
    expect(sitemapRoutes.has(hub.path)).toBe(true);

    const tampered = {
      ...dutiesJson,
      _release: { ...dutiesJson._release, state: 'partial' },
    } as unknown as PharmacyDutiesDataset;
    const guarded = buildPharmacyDirectoryPage(validDescriptor, 'it', root, tampered, now);
    expect(guarded.indexable).toBe(false);
    expect(robotsOf(guarded.html).replace(/\s+/g, '')).toBe('noindex,follow');
    expect(guarded.html).not.toContain('"@type":"ItemList"');

    const guardedHub = buildPharmacyDirectoryPage(hubDescriptor!, 'it', root, tampered, now);
    expect(guardedHub.indexable).toBe(false);
    expect(robotsOf(guardedHub.html).replace(/\s+/g, '')).toBe('noindex,follow');
    expect(guardedHub.html).not.toContain('"@type":"CollectionPage"');
    expect(guardedHub.html).not.toContain('"@type":"ItemList"');
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
