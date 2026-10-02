import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHistory } from '../build-plugins/fuelDailyPagesPlugin';
import { computeZoneAvg, stationPriceForFuel } from '../scripts/snapshot-fuel-history.mjs';

describe('fuel history observed price input', () => {
  it('never fills a missing diesel price and excludes it from the snapshot average', () => {
    const stations = [
      { address: 'Chiasso', sp95PriceChf: 1.7 },
      { address: 'Chiasso', sp95PriceChf: 1.8, dieselPriceChf: 1.9 },
    ];
    expect(stationPriceForFuel(stations[0], 'diesel')).toBeNull();
    expect(computeZoneAvg(stations, 'chiasso', 'diesel')).toBe(1.9);
    expect(computeZoneAvg(stations, 'chiasso', 'benzina')).toBe(1.75);
  });

  it.each([undefined, null, 0, -1, NaN, Infinity])('rejects missing or invalid diesel %s', (dieselPriceChf) => {
    expect(stationPriceForFuel({ sp95PriceChf: 1.7, dieselPriceChf }, 'diesel')).toBeNull();
  });

  it('accepts diesel without petrol but rejects explicitly estimated diesel', () => {
    expect(stationPriceForFuel({ dieselPriceChf: 1.9 }, 'diesel')).toBe(1.9);
    expect(stationPriceForFuel({ sp95PriceChf: 1.7, dieselPriceChf: 1.78, dieselSource: 'derived' }, 'diesel')).toBeNull();
  });
});


describe('legacy fuel snapshot provenance', () => {
  it.each(['derived', 'mixed'] as const)('excludes Swiss synthetic diesel marked %s without rewriting historical files', (source) => {
    const root = mkdtempSync(join(tmpdir(), 'fuel-history-provenance-'));
    try {
      const historyDir = join(root, 'data', 'fuel-prices-history');
      mkdirSync(historyDir, { recursive: true });
      const file = join(historyDir, '2026-04-19.json');
      const original = JSON.stringify({ date: '2026-04-19', diesel: { source },
        regional: { benzina: 1.7, diesel: 1.78 }, zones: { chiasso: { benzina: 1.7, diesel: 1.78 } },
        stations: { alpha: { benzina: 1.7, diesel: 1.78 } }, italianCities: { como: { diesel: 1.6 } },
      });
      writeFileSync(file, original);
      const [snapshot] = readHistory(root);
      expect(snapshot.regional).toEqual({ benzina: 1.7, diesel: null });
      expect(snapshot.zones.chiasso).toEqual({ benzina: 1.7, diesel: null });
      expect(snapshot.stations?.alpha).toEqual({ benzina: 1.7, diesel: null });
      expect(snapshot.italianCities?.como).toEqual({ diesel: 1.6 });
      expect(readFileSync(file, 'utf8')).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
