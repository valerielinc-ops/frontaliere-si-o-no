import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPlateAuctionContext, plateAuctionsPagesPlugin, renderPlateAuctionPage } from '../build-plugins/plateAuctionsPagesPlugin';
import { buildPlateAuctionPath } from '../services/plateAuctions/paths';
import { AD_SLOTS } from '../services/adsenseSlots';
import { auditPage } from '../scripts/adsense-prereview-audit.mjs';

const tempDirs: string[] = [];
const FULL_FIXTURE_GROUPS = [
  { sourceKey: 'GR', canton: 'Grigioni', platePrefix: 'GR', count: 5 },
  { sourceKey: 'VS', canton: 'Vallese', platePrefix: 'VS', count: 5 },
  { sourceKey: 'ZH', canton: 'Zurigo', platePrefix: 'ZH', count: 31 },
] as const;

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureRoot({ auctionCount = 1, withDist = false }: { auctionCount?: number; withDist?: boolean } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'plate-auction-pages-'));
  tempDirs.push(rootDir);
  const dataDir = join(rootDir, 'public', 'data');
  mkdirSync(dataDir, { recursive: true });
  const registryDir = join(rootDir, 'data');
  mkdirSync(registryDir, { recursive: true });
  const groups = auctionCount === 41 ? FULL_FIXTURE_GROUPS : [{ sourceKey: 'GR', canton: 'Grigioni', platePrefix: 'GR', count: auctionCount }];
  const auctions = groups.flatMap((group, groupIndex) => Array.from({ length: group.count }, (_, index) => {
    const filtered = auctionCount > 1 && groupIndex === groups.length - 1 && index === group.count - 1;
    return {
      id: `${group.sourceKey.toLowerCase()}-live-${index}`,
      sourceKey: group.sourceKey,
      canton: group.canton,
      platePrefix: group.platePrefix,
      normalizedPlate: `${group.platePrefix}${index + 8}`,
      currentBidChf: 800 + index,
      auctionStatus: filtered ? 'closed' : 'active',
      dataConfidence: filtered ? 'conflicting' : 'partial',
      officialAuctionUrl: 'https://eauktion.gr.ch/',
    };
  }));
  const sources = Object.fromEntries(groups.map((group) => [group.sourceKey.toLowerCase(), {
    canton: group.canton,
    plateCode: group.sourceKey,
    officialUrl: 'https://eauktion.gr.ch/',
    status: 'active',
    rowCount: group.count,
  }]));
  writeFileSync(join(dataDir, 'plate-auctions.json'), JSON.stringify({
    generatedAt: '2026-09-13T12:00:00.000Z',
    sources,
    auctions,
    history: [{ id: 'gr-final', sourceKey: 'GR', canton: 'Grigioni', platePrefix: 'GR', normalizedPlate: 'GR7', finalPriceChf: 7000, finalPriceVerifiedAt: '2026-09-12T18:00:00.000Z', auctionStatus: 'sold', dataConfidence: 'verified', officialAuctionUrl: 'https://eauktion.gr.ch/' }],
  }), 'utf8');
  writeFileSync(join(registryDir, 'plate-auction-sources-registry.json'), JSON.stringify({
    generatedAt: '2026-09-13T12:00:00.000Z',
    sources: Object.fromEntries(groups.map((group) => [group.sourceKey.toLowerCase(), {
      canton: group.canton,
      plateCode: group.sourceKey,
      officialUrl: 'https://eauktion.gr.ch/',
      accessMethod: 'manual',
      fetchFrequency: 'P1D',
      timezone: 'Europe/Zurich',
      parserVersion: 'test',
      availableFields: [],
      rateLimit: 'test',
      termsOfUse: 'test',
      owner: 'test',
      status: 'active',
      sourceFetchedAt: '2026-09-13T12:00:00.000Z',
    }])),
  }), 'utf8');
  if (withDist) {
    mkdirSync(join(rootDir, 'dist'), { recursive: true });
  }
  return rootDir;
}

describe('plate-auction static pages', () => {
  it('keeps every locale of a detail page above the AdSense thin-content floor', () => {
    // Run 35339314162 failed with 10 blocking `ads_on_thin_content_page`
    // findings, all on plate-auction detail pages and all in de/en. Of the 19
    // sampled pages 0 passed: IT read 146 words, FR 143, EN 137, DE 126 against
    // the 140-word floor, so the identical template was thin in every locale
    // and only dipped under the line where German and English compound the
    // same sentences into fewer tokens. This asserts the real auditor's verdict
    // on the real rendered page, not a proxy for it.
    const rootDir = fixtureRoot();
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const rendered = renderPlateAuctionPage({ locale, view: 'detail', canton: 'GR', plate: 'GR7', rootDir });
      const audited = auditPage(`https://frontaliereticino.ch/${locale}/x/`, 'x', rendered.html, 'plate-auctions');
      expect(audited.issues, `${locale}: blocking AdSense findings`).toEqual([]);
      expect(audited.metrics.wordCount, `${locale}: word count`).toBeGreaterThanOrEqual(140);
      expect(audited.metrics.thin, `${locale}: still thin`).toBe(false);
    }
  });

  it('renders registry-backed canton coverage and freshness on the national hub', () => {
    const rootDir = fixtureRoot();
    const rendered = renderPlateAuctionPage({ locale: 'it', view: 'hub', rootDir });

    expect(rendered.html).toContain('Copertura per cantone');
    expect(rendered.html).toContain('data-canton-status=active');
    expect(rendered.html).toContain('Grigioni (GR)');
    expect(rendered.html).toContain('Ultimo aggiornamento');
    expect(rendered.html).toContain('https://eauktion.gr.ch/');

    const english = renderPlateAuctionPage({ locale: 'en', view: 'hub', rootDir });
    expect(english.html).toContain('Graubünden (GR)');
  });

  it('shows coverage in progress and suppresses listings when no registry source is active', () => {
    const rootDir = fixtureRoot();
    const registryPath = join(rootDir, 'data', 'plate-auction-sources-registry.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as { sources: Record<string, { status: string }> };
    for (const source of Object.values(registry.sources)) source.status = 'unverified';
    writeFileSync(registryPath, JSON.stringify(registry), 'utf8');

    const rendered = renderPlateAuctionPage({ locale: 'it', view: 'hub', rootDir });
    expect(rendered.html).toContain('Copertura in corso');
    expect(rendered.html).toContain('data-canton-status=unverified');
    expect(rendered.html).not.toContain('<table>');
    expect(rendered.html).not.toContain('GR8');
    expect(rendered.html).toContain('https://eauktion.gr.ch/');
  });

  it('fails closed when the source registry is malformed', () => {
    const rootDir = fixtureRoot();
    writeFileSync(join(rootDir, 'data', 'plate-auction-sources-registry.json'), JSON.stringify({
      generatedAt: '2026-09-13T12:00:00.000Z',
      sources: null,
    }), 'utf8');

    const rendered = renderPlateAuctionPage({ locale: 'it', view: 'hub', rootDir });
    expect(rendered.html).toContain('Il registro delle fonti cantonali non è disponibile');
    expect(rendered.html).not.toContain('<table>');
    expect(rendered.html).not.toContain('GR8');
  });

  it('uses verified history for rankings and keeps the live row out', () => {
    const rootDir = fixtureRoot();
    const rendered = renderPlateAuctionPage({ locale: 'it', view: 'rankings', rootDir });
    expect(rendered.urlPath).toBe('aste-targhe-svizzera/classifiche');
    expect(rendered.html).toContain('GR7');
    expect(rendered.html).not.toContain('GR8');
    expect(rendered.html).toContain('https://frontaliereticino.ch/aste-targhe-svizzera/classifiche/');
    expect(rendered.html).toContain('id=root');
    expect(rendered.html).toContain('class="seo-static-content plate-auction-static"');
    expect(rendered.html).toContain('data-plate-auctions-static=true');
    expect(rendered.html).not.toContain('<main><nav');
  });

  it('emits vehicle type and the shared top/in-feed ad slots in static pages', () => {
    const rootDir = fixtureRoot({ auctionCount: 5 });
    const snapshotPath = join(rootDir, 'public', 'data', 'plate-auctions.json');
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { auctions: Array<Record<string, unknown>> };
    snapshot.auctions[0].vehicleType = 'motorcycle';
    writeFileSync(snapshotPath, JSON.stringify(snapshot), 'utf8');

    const rendered = renderPlateAuctionPage({ locale: 'it', view: 'hub', rootDir });
    expect(rendered.html).toContain('Moto');
    expect(rendered.html).toContain('ft-plate-auction-top-ad');
    expect(rendered.html).toContain(`data-ad-slot=${AD_SLOTS.JOBDETAIL_TOP_BANNER.slot}`);
    expect(rendered.html).toContain('ft-infeed-ad');
    expect(rendered.html).toContain(`data-ad-slot=${AD_SLOTS.JOBLIST_INFEED_DESKTOP.slot}`);
    expect(rendered.html).toContain('id=rail-left-root');
    expect(rendered.html).toContain('id=rail-right-root');
  });

  it('caps large canton catalogues before first paint', () => {
    const rootDir = fixtureRoot({ auctionCount: 102 });
    const rendered = renderPlateAuctionPage({ locale: 'de', view: 'canton', canton: 'GR', rootDir });

    expect(Buffer.byteLength(rendered.html)).toBeLessThan(260 * 1024);
    expect((rendered.html.match(/<tr>/g) || []).length).toBeLessThanOrEqual(106);
    expect(rendered.html).toContain('/de/schweizer-nummernschildauktionen/graubuenden-gr/katalog/');
  });

  it('links the capped canton page to an uncapped directory of all detail pages', () => {
    const rootDir = fixtureRoot({ auctionCount: 2000 });
    const rendered = renderPlateAuctionPage({ locale: 'it', view: 'directory', canton: 'GR', rootDir });

    expect(rendered.urlPath).toBe('aste-targhe-svizzera/grigioni-gr/catalogo');
    expect(rendered.html).toContain('/aste-targhe-svizzera/grigioni-gr/gr8/');
    expect(rendered.html).toContain('/aste-targhe-svizzera/grigioni-gr/gr2006/');
    expect((rendered.html.match(/<li>/g) || []).length).toBe(2000);
  });

  it('caps extra detail links when a small current catalogue has old rows', () => {
    const rootDir = fixtureRoot();
    const snapshotPath = join(rootDir, 'public', 'data', 'plate-auctions.json');
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { auctions: Array<Record<string, unknown>> };
    snapshot.auctions.push(...Array.from({ length: 2500 }, (_, index) => ({
      ...snapshot.auctions[0],
      id: `gr-expired-${index}`,
      normalizedPlate: `EXPIRED${index}`,
      auctionStatus: 'closed',
      dataConfidence: 'partial',
    })));
    writeFileSync(snapshotPath, JSON.stringify(snapshot), 'utf8');

    const rendered = renderPlateAuctionPage({ locale: 'it', view: 'canton', canton: 'GR', rootDir });

    expect(rendered.html).toContain('EXPIRED0');
    expect(rendered.html).not.toContain('EXPIRED48');
    expect((rendered.html.match(/<li>/g) || []).length).toBeLessThanOrEqual(48);
  });

  it('renders a historical detail page with the same indexable ad surfaces', () => {
    const rootDir = fixtureRoot();
    const rendered = renderPlateAuctionPage({ locale: 'en', view: 'detail', canton: 'GR', plate: 'GR7', rootDir });
    expect(rendered.urlPath).toBe('en/swiss-plate-auctions/graubunden-gr/gr7');
    expect(rendered.html).toContain('GR7');
    expect(rendered.html).toContain('index, follow');
    expect(rendered.html).toContain('ft-plate-auction-top-ad');
    expect(rendered.html).toContain('id=rail-left-root');
    expect(rendered.html).toContain('id=rail-right-root');
    expect(rendered.html).not.toContain('noindex');
  });

  it('keeps individual auction records indexable', () => {
    const rootDir = fixtureRoot();
    const rendered = renderPlateAuctionPage({ locale: 'it', view: 'detail', canton: 'GR', plate: 'GR8', rootDir });
    expect(rendered.html).toContain('index, follow');
    expect(rendered.html).toContain('ft-plate-auction-top-ad');
    expect(rendered.html).toContain('id=rail-left-root');
    expect(rendered.html).toContain('id=rail-right-root');
    expect(rendered.html).toContain('GR8');
    expect(rendered.html).not.toContain('noindex');
  });

  it('keeps a live row with an unparseable deadline consistent with the dynamic feed', () => {
    const rootDir = fixtureRoot();
    const snapshotPath = join(rootDir, 'public', 'data', 'plate-auctions.json');
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { auctions: Array<Record<string, unknown>> };
    snapshot.auctions[0].endsAt = 'not-a-date';
    writeFileSync(snapshotPath, JSON.stringify(snapshot), 'utf8');
    const rendered = renderPlateAuctionPage({ locale: 'it', view: 'hub', rootDir });
    expect(rendered.html).toContain('GR8');
  });

  it('emits the site hreflang locale codes for auction pages', () => {
    const rootDir = fixtureRoot();
    const rendered = renderPlateAuctionPage({ locale: 'fr', view: 'canton', canton: 'GR', rootDir });
    const hreflangs = [...rendered.html.matchAll(/hreflang=["']?([^"'\s>]+)["']?/g)].map((match) => match[1]);
    expect(hreflangs).toEqual(['it', 'en', 'de', 'fr', 'x-default']);
  });

  it('keeps the visible H1 distinct and emits a breadcrumb schema block', () => {
    const rootDir = fixtureRoot();
    const rendered = renderPlateAuctionPage({ locale: 'it', view: 'canton', canton: 'GR', rootDir });
    const title = rendered.html.match(/<title>([^<]*)<\/title>/)?.[1] || '';
    const h1 = rendered.html.match(/<h1[^>]*>([^<]*)<\/h1>/)?.[1] || '';
    expect(h1).toContain('(guida frontaliere)');
    expect(h1).not.toBe(title);
    expect(rendered.html).toContain('"@type":"BreadcrumbList"');
  });

  it('emits each current URL exactly once in the breadcrumb chain', () => {
    const rootDir = fixtureRoot();
    const pages = [
      renderPlateAuctionPage({ locale: 'it', view: 'hub', rootDir }),
      renderPlateAuctionPage({ locale: 'it', view: 'rankings', rootDir }),
      renderPlateAuctionPage({ locale: 'it', view: 'canton', canton: 'GR', rootDir }),
      renderPlateAuctionPage({ locale: 'it', view: 'detail', canton: 'GR', plate: 'GR7', rootDir }),
    ];

    for (const page of pages) {
      const payload = [...page.html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
        .map((match) => match[1])
        .find((json) => json.includes('"@type":"BreadcrumbList"'));
      expect(payload).toBeDefined();
      const breadcrumb = JSON.parse(payload!) as { itemListElement: Array<{ position: number; item?: string }> };
      const items = breadcrumb.itemListElement;
      expect(items.map((item) => item.position)).toEqual(items.map((_, index) => index + 1));
      expect(new Set(items.map((item) => item.item)).size).toBe(items.length);
      expect(items.at(-1)?.item).toBe(`https://frontaliereticino.ch/${page.urlPath}/`);
    }
  });

  it('bounds a large canton index while keeping detail pages separate', () => {
    const rootDir = fixtureRoot({ auctionCount: 2000 });
    const rendered = renderPlateAuctionPage({ locale: 'de', view: 'canton', canton: 'GR', rootDir });

    expect(Buffer.byteLength(rendered.html, 'utf8')).toBeLessThan(260 * 1024);
    expect(rendered.html).toContain('GR2006');
    expect(rendered.html).not.toContain('/gr56/');
  });

  it('materializes every published detail URL and includes it in the sitemap', async () => {
    const rootDir = fixtureRoot({ auctionCount: 41, withDist: true });
    const closeBundle = plateAuctionsPagesPlugin(rootDir).closeBundle;
    if (typeof closeBundle !== 'function') throw new Error('plate-auction plugin has no closeBundle hook');
    await closeBundle();

    const sitemap = readFileSync(join(rootDir, 'dist', 'sitemap-plate-auctions.xml'), 'utf8');
    const sitemapLocs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    expect(sitemapLocs).toHaveLength(4 * (2 + 26 + 3 + 41));
    expect(new Set(sitemapLocs).size).toBe(sitemapLocs.length);
    const expectedDetailUrls = new Set<string>();
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const hubPath = buildPlateAuctionPath({ locale, view: 'hub' });
      const hub = readFileSync(join(rootDir, 'dist', hubPath.slice(1), 'index.html'), 'utf8');
      for (const group of FULL_FIXTURE_GROUPS) {
        const cantonPath = buildPlateAuctionPath({ locale, view: 'canton', canton: group.sourceKey });
        const canton = readFileSync(join(rootDir, 'dist', cantonPath.slice(1), 'index.html'), 'utf8');
        const directoryPath = buildPlateAuctionPath({ locale, view: 'directory', canton: group.sourceKey });
        const directory = readFileSync(join(rootDir, 'dist', directoryPath.slice(1), 'index.html'), 'utf8');
        expect(hub).toContain(`href="${cantonPath}"`);
        expect(canton).toContain(`href="${directoryPath}"`);
        for (let index = 0; index < group.count; index++) {
          const detailPath = buildPlateAuctionPath({ locale, view: 'detail', canton: group.sourceKey, plate: `${group.platePrefix}${index + 8}` });
          const detailUrl = `https://frontaliereticino.ch${detailPath}`;
          const conflicting = group.sourceKey === 'ZH' && index === group.count - 1;
          if (conflicting) {
            expect(sitemap).not.toContain(`<loc>${detailUrl}</loc>`);
            expect(canton).not.toContain(`href="${detailPath}"`);
          } else {
            expectedDetailUrls.add(detailUrl);
            expect(sitemap).toContain(`<loc>${detailUrl}</loc>`);
            expect(directory).toContain(`href="${detailPath}"`);
          }
        }
        if (group.sourceKey === 'ZH') {
          const itemListPayload = [...directory.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
            .map((match) => match[1])
            .find((json) => json.includes('"@type":"ItemList"'));
          expect(itemListPayload).toBeDefined();
          const itemList = JSON.parse(itemListPayload!) as { mainEntity: { itemListElement: Array<{ name: string }> } };
          expect(itemList.mainEntity.itemListElement).toHaveLength(group.count - 1);
          expect(itemList.mainEntity.itemListElement.map((item) => item.name)).not.toContain('ZH38');
        }
      }
      const historyPath = buildPlateAuctionPath({ locale, view: 'detail', canton: 'GR', plate: 'GR7' });
      const historyUrl = `https://frontaliereticino.ch${historyPath}`;
      expectedDetailUrls.add(historyUrl);
      expect(sitemap).toContain(`<loc>${historyUrl}</loc>`);
      const historyHtml = readFileSync(join(rootDir, 'dist', historyPath.slice(1), 'index.html'), 'utf8');
      expect(historyHtml).toContain('index, follow');
      expect(historyHtml).toContain('ft-plate-auction-top-ad');
    }
    expect(expectedDetailUrls.size).toBe(164);
  });

  it('renders from a precomputed context instead of re-reading the snapshot per page', () => {
    // Regressione #8753: ogni pagina di dettaglio rileggeva lo snapshot da
    // disco (227 min di closeBundle in CI). Con un contesto passato dal
    // plugin il render deve usare QUELLO, non il rootDir.
    const contextRoot = fixtureRoot({ auctionCount: 41 });
    const otherRoot = fixtureRoot();
    const context = loadPlateAuctionContext(contextRoot);
    const zurich = context.detailRows.find((row) => row.platePrefix === 'ZH');
    expect(zurich).toBeDefined();
    const args = { locale: 'it' as const, view: 'detail' as const, canton: 'ZH', plate: zurich!.normalizedPlate, vehicleType: zurich!.vehicleType };
    const fromDisk = renderPlateAuctionPage({ ...args, rootDir: contextRoot });
    const withContext = renderPlateAuctionPage({ ...args, rootDir: otherRoot, context });
    const withoutContext = renderPlateAuctionPage({ ...args, rootDir: otherRoot });
    expect(withContext.html).toBe(fromDisk.html);
    expect(withoutContext.html).not.toBe(fromDisk.html);
  });
});
