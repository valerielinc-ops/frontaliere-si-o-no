import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { plateAuctionsPagesPlugin, renderPlateAuctionPage } from '../build-plugins/plateAuctionsPagesPlugin';
import { buildPlateAuctionPath } from '../services/plateAuctions/paths';

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
  if (withDist) {
    mkdirSync(join(rootDir, 'dist'), { recursive: true });
  }
  return rootDir;
}

describe('plate-auction static pages', () => {
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

  it('renders an empty, explicit detail page when a historical URL has no live row', () => {
    const rootDir = fixtureRoot();
    const rendered = renderPlateAuctionPage({ locale: 'en', view: 'detail', canton: 'GR', plate: 'GR7', rootDir });
    expect(rendered.urlPath).toBe('en/swiss-plate-auctions/graubunden-gr/gr7');
    expect(rendered.html).toContain('No public row is available right now.');
    expect(rendered.html).not.toContain('GR8');
  });

  it('emits the site hreflang locale codes for auction pages', () => {
    const rootDir = fixtureRoot();
    const rendered = renderPlateAuctionPage({ locale: 'fr', view: 'canton', canton: 'GR', rootDir });
    const hreflangs = [...rendered.html.matchAll(/hreflang=["']?([^"'\s>]+)["']?/g)].map((match) => match[1]);
    expect(hreflangs).toEqual(['it', 'en', 'de', 'fr', 'x-default']);
  });

  it('links every sitemap detail URL from static locale hubs', async () => {
    const rootDir = fixtureRoot({ auctionCount: 41, withDist: true });
    const closeBundle = plateAuctionsPagesPlugin(rootDir).closeBundle;
    if (typeof closeBundle !== 'function') throw new Error('plate-auction plugin has no closeBundle hook');
    await closeBundle();

    const sitemap = readFileSync(join(rootDir, 'dist', 'sitemap-plate-auctions.xml'), 'utf8');
    const expectedDetailUrls = new Set<string>();
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const hubPath = buildPlateAuctionPath({ locale, view: 'hub' });
      const hub = readFileSync(join(rootDir, 'dist', hubPath.slice(1), 'index.html'), 'utf8');
      for (const group of FULL_FIXTURE_GROUPS) {
        const cantonPath = buildPlateAuctionPath({ locale, view: 'canton', canton: group.sourceKey });
        const canton = readFileSync(join(rootDir, 'dist', cantonPath.slice(1), 'index.html'), 'utf8');
        expect(hub).toContain(`href="${cantonPath}"`);
        for (let index = 0; index < group.count; index++) {
          const detailPath = buildPlateAuctionPath({ locale, view: 'detail', canton: group.sourceKey, plate: `${group.platePrefix}${index + 8}` });
          const detailUrl = `https://frontaliereticino.ch${detailPath}`;
          expectedDetailUrls.add(detailUrl);
          expect(sitemap).toContain(`<loc>${detailUrl}</loc>`);
          expect(canton).toContain(`href="${detailPath}"`);
        }
      }
    }
    expect(expectedDetailUrls.size).toBe(164);
  });
});
