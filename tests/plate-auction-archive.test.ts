// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPlateAuctionArchive, writePlateAuctionArchive } from '../scripts/lib/plate-auction-archive.mjs';
import { parsePlateAuctionApiSnapshot, withStaticPlateAuctionDetail } from '../services/plateAuctions/api';
import { renderPlateAuctionPage } from '../build-plugins/plateAuctionsPagesPlugin';
import { PLATE_AUCTION_DETAIL_SEED_ID } from '../scripts/lib/plateAuctionSections.mjs';
import registry from '../data/plate-auction-sources-registry.json';

const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString();
const row = () => ({
  id: 'fr-old', sourceKey: 'FR', sourceRecordId: 'old', canton: 'Friburgo',
  platePrefix: 'FR', plateNumber: '84262', normalizedPlate: 'FR84262',
  vehicleType: 'car', listingType: 'auction', auctionStatus: 'closed',
  currentBidChf: 800, endsAt: day(-2), closedAt: day(-2),
  officialAuctionUrl: 'https://example.test/auction/',
  sourceFetchedAt: day(-3), lastVerifiedAt: day(-3),
  dataConfidence: 'partial', rawSnapshotHash: 'public-observation',
});
const sources = { fr: { ...registry.sources.fr, status: 'active', rowCount: 0 } };
const directories: string[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-archive-')); directories.push(dir); return dir; };
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('durable plate detail archive', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('preserves an attested observation with unknown availability through SSR/hydration in %s', (locale) => {
    const root = temp();
    const historical = { ...row(), listingType: 'fixed-price', auctionStatus: 'unknown',
      sourceCategory: 'fixed-price-api-recovery', lastSeenAt: day(-3), startingPriceChf: 800,
      currentBidChf: undefined, endsAt: undefined, closedAt: undefined };
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.mkdirSync(path.join(root, 'public/data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/plate-auction-sources-registry.json'), JSON.stringify(registry));
    fs.writeFileSync(path.join(root, 'public/data/plate-auctions-recovery.json'), JSON.stringify({ history: [historical] }));
    const page = renderPlateAuctionPage({ rootDir: root, locale, view: 'detail', canton: 'FR', plate: 'FR84262' });
    const pattern = new RegExp(`<script[^>]*id=["']?${PLATE_AUCTION_DETAIL_SEED_ID}["']?[^>]*>([\\s\\S]*?)<\\/script>`);
    const serialized = page.html.match(pattern)?.[1];
    expect(serialized).toBeTruthy();
    expect(page.html).toContain('data-plate-observation-notice');
    const notices = { it: 'Disponibilità attuale e vendita non confermate', en: 'Current availability and sale are not confirmed', de: 'Aktuelle Verfügbarkeit und Verkauf sind nicht bestätigt', fr: 'La disponibilité actuelle et la vente ne sont pas confirmées' };
    expect(page.html).toContain(notices[locale]);
    const snapshot = parsePlateAuctionApiSnapshot({ schema: 1, generatedAt: day(0), sources, auctions: [], history: [] });
    const hydrated = withStaticPlateAuctionDetail(snapshot, `/${page.urlPath.replace(/^\/+|\/+$/g, '')}/`, serialized!);
    expect(hydrated.history?.[0]).toMatchObject({ id: historical.id, auctionStatus: 'unknown', sourceCategory: 'fixed-price-api-recovery' });
    expect(hydrated.history?.[0]).not.toHaveProperty('finalPriceChf');
    expect(hydrated.history?.[0]).not.toHaveProperty('closedAt');
  });

  it('does not hydrate an arbitrary unknown status as historical evidence', () => {
    const pathname = '/aste-targhe-svizzera/friburgo-fr/fr84262/';
    const snapshot = parsePlateAuctionApiSnapshot({ schema: 1, generatedAt: day(0), sources, auctions: [], history: [] });
    for (const change of [{}, { sourceCategory: 'fixed-price-api-recovery' }, { sourceCategory: 'fixed-price-api-recovery', lastSeenAt: 'invalid' }]) {
      const serialized = JSON.stringify({ schema: 1, path: pathname, row: { ...row(), auctionStatus: 'unknown', listingType: 'fixed-price', ...change } });
      expect(withStaticPlateAuctionDetail(snapshot, pathname, serialized)).toBe(snapshot);
    }
  });

  it('rejects contradictory historical seeds and always prefers the live identity', () => {
    const pathname = '/aste-targhe-svizzera/friburgo-fr/fr84262/';
    const historical = { ...row(), listingType: 'fixed-price', auctionStatus: 'unknown',
      sourceCategory: 'fixed-price-api-recovery', lastSeenAt: day(-3), startingPriceChf: 800,
      currentBidChf: undefined, endsAt: undefined, closedAt: undefined };
    const snapshot = parsePlateAuctionApiSnapshot({ schema: 1, generatedAt: day(0), sources, auctions: [], history: [] });
    for (const change of [{ startingPriceChf: undefined }, { currentBidChf: 900 }, { bidCount: 1 },
      { closedAt: day(-1) }, { endsAt: day(-1) }, { finalPriceChf: 800 }, { finalPriceVerifiedAt: day(-1) }]) {
      const seed = JSON.stringify({ schema: 1, path: pathname, row: { ...historical, ...change } });
      expect(withStaticPlateAuctionDetail(snapshot, pathname, seed)).toBe(snapshot);
    }
    const live = parsePlateAuctionApiSnapshot({ schema: 1, generatedAt: day(0), sources,
      auctions: [{ ...historical, auctionStatus: 'active', sourceCategory: 'fixed-price-api', sourceFetchedAt: day(0) }], history: [] });
    expect(withStaticPlateAuctionDetail(live, pathname, JSON.stringify({ schema: 1, path: pathname, row: historical }))).toBe(live);
  });

  it('does not mistake an old active history observation for the current inventory', () => {
    const pathname = '/aste-targhe-svizzera/friburgo-fr/fr84262/';
    const historical = { ...row(), listingType: 'fixed-price', auctionStatus: 'unknown',
      sourceCategory: 'fixed-price-api-recovery', lastSeenAt: day(-3), startingPriceChf: 800,
      currentBidChf: undefined, endsAt: undefined, closedAt: undefined };
    const oldObservation = { ...historical, auctionStatus: 'active', sourceCategory: 'fixed-price-api' };
    const snapshot = parsePlateAuctionApiSnapshot({ schema: 1, generatedAt: day(0), sources, auctions: [], history: [oldObservation] });
    const serialized = JSON.stringify({ schema: 1, path: pathname, row: historical });
    const hydrated = withStaticPlateAuctionDetail(snapshot, pathname, serialized);
    expect(hydrated.history).toHaveLength(2);
    expect(hydrated.history?.[0].auctionStatus).toBe('unknown');
    expect(hydrated.history?.[1]).toEqual(snapshot.history?.[0]);
    for (const change of [{ sourceFetchedAt: day(-1) }, { auctionStatus: 'closed' }]) {
      const newer = parsePlateAuctionApiSnapshot({ schema: 1, generatedAt: day(0), sources, auctions: [], history: [{ ...oldObservation, ...change }] });
      expect(withStaticPlateAuctionDetail(newer, pathname, serialized)).toBe(newer);
    }
  });

  it('retains a closed record after it leaves the rolling snapshot and is idempotent', () => {
    const dir = temp();
    const snapshot = { sources, auctions: [], history: [{ ...row(), bidderName: 'private', winnerName: 'private' }] };
    expect(writePlateAuctionArchive(snapshot, dir)).toBe(1);
    expect(writePlateAuctionArchive(snapshot, dir)).toBe(0);
    writePlateAuctionArchive({ sources, auctions: [], history: [] }, dir);
    const [archived] = readPlateAuctionArchive(dir);
    expect(archived.id).toBe(snapshot.history[0].id);
    expect(archived).not.toHaveProperty('bidderName');
    expect(archived).not.toHaveProperty('winnerName');
    expect(archived).not.toHaveProperty('finalPriceChf');
  });

  it('does not archive active, conflicting, disabled-source or unsafe-identity rows', () => {
    const dir = temp();
    const rows = [
      { ...row(), auctionStatus: 'active' }, { ...row(), dataConfidence: 'conflicting' },
      { ...row(), sourceKey: 'GL', platePrefix: 'GL', normalizedPlate: 'GL12' },
      { ...row(), normalizedPlate: '../../outside' },
    ];
    expect(writePlateAuctionArchive({ sources, history: rows }, dir)).toBe(0);
    expect(readPlateAuctionArchive(dir)).toEqual([]);
  });

  it('keeps vehicle identities distinct and never overwrites a newer observation with an older one', () => {
    const dir = temp();
    const current = row();
    writePlateAuctionArchive({ sources, history: [current, { ...current, id: 'fr-moto', vehicleType: 'motorcycle' }] }, dir);
    writePlateAuctionArchive({ sources, history: [{ ...current, sourceFetchedAt: day(-10), currentBidChf: 1 }] }, dir);
    const records = readPlateAuctionArchive(dir);
    expect(records).toHaveLength(2);
    expect(records.find((record: any) => record.vehicleType === 'car').currentBidChf).toBe(800);
  });

  it('renders a recovered detail and carries the same validated record through hydration', () => {
    const root = temp();
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.mkdirSync(path.join(root, 'public/data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/plate-auction-sources-registry.json'), JSON.stringify(registry));
    fs.writeFileSync(path.join(root, 'public/data/plate-auctions.json'), JSON.stringify({ sources, auctions: [], history: [] }));
    fs.writeFileSync(path.join(root, 'public/data/plate-auctions-recovery.json'), JSON.stringify({ history: [row()] }));
    const page = renderPlateAuctionPage({ rootDir: root, locale: 'it', view: 'detail', canton: 'FR', plate: 'FR84262' });
    const pattern = new RegExp(`<script[^>]*id=["']?${PLATE_AUCTION_DETAIL_SEED_ID}["']?[^>]*>([\\s\\S]*?)<\\/script>`);
    const payload = page!.html.match(pattern)?.[1];
    expect(payload).toBeTruthy();
    const snapshot = parsePlateAuctionApiSnapshot({ schema: 1, generatedAt: day(0), sources, auctions: [], history: [] });
    const hydrated = withStaticPlateAuctionDetail(snapshot, '/aste-targhe-svizzera/friburgo-fr/fr84262/', payload!);
    expect(hydrated.history?.[0].id).toBe('fr-old');
    expect(hydrated.history?.[0]).not.toHaveProperty('finalPriceChf');
  });

  it('does not replay another route, vehicle, blocked source or an outdated SSR record over live data', () => {
    const pathname = '/aste-targhe-svizzera/friburgo-fr/fr84262/';
    const record = row();
    const payload = JSON.stringify({ schema: 1, path: pathname, row: record });
    const snapshot = parsePlateAuctionApiSnapshot({ schema: 1, generatedAt: day(0), sources, auctions: [], history: [] });
    expect(withStaticPlateAuctionDetail(snapshot, pathname.replace('84262', '999'), payload)).toBe(snapshot);
    expect(withStaticPlateAuctionDetail(snapshot, pathname, JSON.stringify({ schema: 1, path: pathname, row: { ...record, vehicleType: 'motorcycle' } }))).toBe(snapshot);
    const blocked = { ...snapshot, sources: { fr: { ...snapshot.sources.fr, status: 'blocked' as const } } };
    expect(withStaticPlateAuctionDetail(blocked, pathname, payload)).toBe(blocked);
    const fresh = { ...snapshot, history: [{ ...snapshot.history?.[0], ...record, id: 'fr-fresh' }] } as any;
    expect(withStaticPlateAuctionDetail(fresh, pathname, payload)).toBe(fresh);
  });
});
