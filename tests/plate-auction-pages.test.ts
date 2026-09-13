import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { renderPlateAuctionPage } from '../build-plugins/plateAuctionsPagesPlugin';

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureRoot() {
  const rootDir = mkdtempSync(join(tmpdir(), 'plate-auction-pages-'));
  tempDirs.push(rootDir);
  const dataDir = join(rootDir, 'public', 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'plate-auctions.json'), JSON.stringify({
    generatedAt: '2026-09-13T12:00:00.000Z',
    sources: { gr: { canton: 'Grigioni', plateCode: 'GR', officialUrl: 'https://eauktion.gr.ch/', status: 'active', rowCount: 1 } },
    auctions: [{ id: 'gr-live', sourceKey: 'GR', canton: 'Grigioni', platePrefix: 'GR', normalizedPlate: 'GR8', currentBidChf: 800, auctionStatus: 'active', dataConfidence: 'partial', officialAuctionUrl: 'https://eauktion.gr.ch/' }],
    history: [{ id: 'gr-final', sourceKey: 'GR', canton: 'Grigioni', platePrefix: 'GR', normalizedPlate: 'GR7', finalPriceChf: 7000, finalPriceVerifiedAt: '2026-09-12T18:00:00.000Z', auctionStatus: 'sold', dataConfidence: 'verified', officialAuctionUrl: 'https://eauktion.gr.ch/' }],
  }), 'utf8');
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
  });

  it('renders an empty, explicit detail page when a historical URL has no live row', () => {
    const rootDir = fixtureRoot();
    const rendered = renderPlateAuctionPage({ locale: 'en', view: 'detail', canton: 'GR', plate: 'GR7', rootDir });
    expect(rendered.urlPath).toBe('en/swiss-plate-auctions/graubunden-gr/gr7');
    expect(rendered.html).toContain('No public row is available right now.');
    expect(rendered.html).not.toContain('GR8');
  });
});
