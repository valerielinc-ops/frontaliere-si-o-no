import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPharmacyDirectoryPage, pharmacyPageDescriptors } from '../build-plugins/pharmacyDirectoryPagesPlugin';
import { PHARMACY_NOINDEX_TARGET_MARKER } from '../build-plugins/shared/pharmacyNoindexTargetMarker.mjs';
import { isIntentionalPharmacyNoindexPage } from '../scripts/validate-page-seo-quality.mjs';

// Replay 39952023039 (validate:page-seo) and 39927368320 (audit:max-bfs-depth)
// on the reassembled corpus: 336 pharmacy pages read as "noindex" errors
// although the plugin emits them noindex on purpose, and sitemap-farmacie.xml
// shipped 1,465 URLs below crawl depth 4 in en/de/fr.

type Built = ReturnType<typeof buildPharmacyDirectoryPage>;

function buildLocale(locale: 'it' | 'fr'): Built[] {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacy-marker-depth-'));
  try {
    return pharmacyPageDescriptors().map((d) => buildPharmacyDirectoryPage(d, locale, distDir));
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
}

const HREF_RE = /<a\b[^>]*\bhref="([^"]+)"/g;

function hopsFrom(start: string, pages: Map<string, Built>): Map<string, number> {
  const depth = new Map([[start, 0]]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    const page = pages.get(cur);
    // The BFS audit does not follow the links of a noindex page.
    if (!page || !page.indexable) continue;
    for (const m of page.html.matchAll(HREF_RE)) {
      const target = m[1];
      if (!pages.has(target) || depth.has(target)) continue;
      depth.set(target, depth.get(cur)! + 1);
      queue.push(target);
    }
  }
  return depth;
}

describe.each(['it', 'fr'] as const)('pharmacy directory (%s)', (locale) => {
  const built = buildLocale(locale);

  it('declares every deliberate noindex page, and only those', { timeout: 120_000 }, () => {
    const noindex = built.filter((p) => !p.indexable);
    expect(noindex.length).toBeGreaterThan(0);
    for (const p of built) {
      expect(p.html.includes(PHARMACY_NOINDEX_TARGET_MARKER), p.path).toBe(!p.indexable);
      expect(isIntentionalPharmacyNoindexPage(p.path, p.html), p.path).toBe(!p.indexable);
    }
  });

  it('does not let a copied pharmacy marker exempt an unrelated page', () => {
    const markedNoindex = `${PHARMACY_NOINDEX_TARGET_MARKER}\n<meta name="robots" content="noindex">`;
    expect(isIntentionalPharmacyNoindexPage('jobs/example.html', markedNoindex)).toBe(false);
    expect(isIntentionalPharmacyNoindexPage('farmacie/example/index.html', markedNoindex)).toBe(true);
  });

  it('reaches every indexable page within the crawl-depth budget of audit:max-bfs-depth', { timeout: 120_000 }, () => {
    const pages = new Map(built.map((p) => [p.path, p]));
    const hub = locale === 'it' ? '/farmacie/' : '/fr/pharmacies/';
    expect(pages.has(hub)).toBe(true);
    // `/` links /farmacie/ (depth 1); /fr/ (1) links /fr/pharmacies/ (2).
    // Depth ≤ 4 therefore leaves 3 hops from the IT hub and 2 elsewhere.
    const budget = locale === 'it' ? 3 : 2;
    const depth = hopsFrom(hub, pages);
    const tooDeep = built
      .filter((p) => p.indexable && !(depth.get(p.path)! <= budget))
      .map((p) => `${p.path} (${depth.get(p.path) ?? 'unreachable'})`);
    expect(tooDeep.slice(0, 20), `${tooDeep.length} indexable page(s) beyond ${budget} hops from ${hub}`).toEqual([]);
  });
});
