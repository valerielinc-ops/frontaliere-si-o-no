/**
 * Regression test for AE-9 — fuel-station dedup in the crawler.
 *
 * The TCS Firestore feed occasionally returns two documents for the same
 * physical station (same brand name + same postal address) with different
 * ids and drifted coordinates. Observed production case: two "Eni" entries
 * at "Via Cantonale 36, 6987 Caslano" with coords ~500 m apart. This test
 * locks in the dedup behaviour so the bug cannot silently reappear.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildStationDedupKey,
  dedupStations,
  normaliseFuelStationObservation,
  normaliseText,
  roundCoord,
  sortStationsStable,
} from '../scripts/lib/fuel-station-dedup.mjs';

interface FakeStation {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  sp95PriceChf: number;
  dieselPriceChf: number | null;
  updatedAt: string | null;
}

const ENI_CASLANO_A: FakeStation = {
  id: 'TyVGrppSLdVuEl3mGLQi',
  name: 'Eni',
  address: 'Via Cantonale 36, 6987 Caslano',
  lat: 45.97394481908457,
  lng: 8.869804789687063,
  sp95PriceChf: 1.78,
  dieselPriceChf: 1.92,
  updatedAt: '2026-04-18T13:43:03.407Z',
};

const ENI_CASLANO_B: FakeStation = {
  id: 'feGaE8DvyVQLWX2KWvCM',
  name: 'Eni',
  address: 'Via Cantonale 36, 6987 Caslano',
  lat: 45.97979876673632,
  lng: 8.877340395031382,
  sp95PriceChf: 1.81,
  dieselPriceChf: null,
  updatedAt: '2026-04-18T13:41:19.414Z',
};

const UNIQUE_STATION: FakeStation = {
  id: 'LP7oYktKWhoncV2qvpHG',
  name: 'ECSA Energy SA - Caslano',
  address: 'Via Colombera 10, 6987 Caslano',
  lat: 45.97698951091755,
  lng: 8.874521781054243,
  sp95PriceChf: 1.74,
  dieselPriceChf: 1.88,
  updatedAt: '2026-04-18T12:00:00.000Z',
};

describe('normaliseText', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normaliseText('Eni  GONDO!')).toBe('eni gondo');
    expect(normaliseText('Via Cantonale, 36 — 6987 Caslano')).toBe(
      'via cantonale 36 6987 caslano',
    );
  });

  it('is idempotent', () => {
    const once = normaliseText('Eni — Via Cantonale 36');
    expect(normaliseText(once)).toBe(once);
  });

  it('applies compatibility decomposition so full-width variants collide with ASCII', () => {
    // Full-width "Eni" would otherwise survive as a separate key.
    expect(normaliseText('Ｅｎｉ')).toBe('eni');
    expect(normaliseText('Éni')).toBe('eni');
  });

  it('handles null / undefined safely', () => {
    expect(normaliseText(null as unknown as string)).toBe('');
    expect(normaliseText(undefined as unknown as string)).toBe('');
  });
});

describe('normaliseFuelStationObservation', () => {
  it('keeps missing diesel null and records retrieval/source metadata', () => {
    expect(normaliseFuelStationObservation({
      id: 'tcs-1',
      name: 'Éni',
      brand: 'Eni',
      address: 'Via Roma 1',
      lat: 46.0,
      lng: 8.0,
      sp95PriceChf: 1.8,
      dieselPriceChf: null,
      observedAt: '2026-10-29T12:00:00.000Z',
      source: 'fixture-provider',
    })).toMatchObject({
      id: 'tcs-1',
      sp95PriceChf: 1.8,
      dieselPriceChf: null,
      priceStatus: { sp95: 'available', diesel: 'unavailable' },
      dieselSource: 'unknown',
      dieselUpdatedAt: null,
      observedAt: '2026-10-29T12:00:00.000Z',
      source: 'fixture-provider',
    });
  });

  it('rejects observations without coordinates or a usable fuel price', () => {
    expect(normaliseFuelStationObservation({ id: 'missing-price', lat: 46, lng: 8 })).toBeNull();
    expect(normaliseFuelStationObservation({ id: 'missing-coordinates', sp95PriceChf: 1.8 })).toBeNull();
    expect(normaliseFuelStationObservation({ id: 'blank-diesel', lat: 46, lng: 8, dieselPriceChf: ' ' })).toBeNull();
  });
});

describe('sortStationsStable', () => {
  it('does not depend on provider enumeration order', () => {
    const first = sortStationsStable([UNIQUE_STATION, ENI_CASLANO_A]).map((station) => station.id);
    const second = sortStationsStable([ENI_CASLANO_A, UNIQUE_STATION]).map((station) => station.id);
    expect(second).toEqual(first);
  });
});

describe('buildStationDedupKey', () => {
  it('collides for the two Eni Caslano records', () => {
    expect(buildStationDedupKey(ENI_CASLANO_A)).toBe(
      buildStationDedupKey(ENI_CASLANO_B),
    );
  });

  it('does not collide across distinct stations at Caslano', () => {
    expect(buildStationDedupKey(ENI_CASLANO_A)).not.toBe(
      buildStationDedupKey(UNIQUE_STATION),
    );
  });
});

describe('roundCoord', () => {
  it('rounds to 4 decimal places', () => {
    expect(roundCoord(45.97979876673632)).toBe(45.9798);
    expect(roundCoord(8.869804789687063)).toBe(8.8698);
  });

  it('returns null for non-finite values', () => {
    expect(roundCoord(null)).toBeNull();
    expect(roundCoord(undefined)).toBeNull();
    expect(roundCoord(Number.NaN)).toBeNull();
  });
});

describe('dedupStations — Eni Caslano regression', () => {
  it('collapses two Eni Caslano entries into one', () => {
    const logger = vi.fn();
    const { unique, removed } = dedupStations(
      [ENI_CASLANO_A, ENI_CASLANO_B, UNIQUE_STATION],
      { logger },
    );

    expect(unique).toHaveLength(2);
    const eniEntries = unique.filter((s: FakeStation) => s.name === 'Eni');
    expect(eniEntries).toHaveLength(1);
    expect(removed).toHaveLength(1);
  });

  it('keeps the record with the most recent updatedAt', () => {
    // A is newer than B → A wins.
    const { unique } = dedupStations([ENI_CASLANO_B, ENI_CASLANO_A], {
      logger: vi.fn(),
    });
    const kept = unique.find((s: FakeStation) => s.name === 'Eni');
    expect(kept?.id).toBe(ENI_CASLANO_A.id);
    expect(kept?.updatedAt).toBe(ENI_CASLANO_A.updatedAt);
  });

  it('logs dedup decisions to the provided logger', () => {
    const logger = vi.fn();
    dedupStations([ENI_CASLANO_A, ENI_CASLANO_B], { logger });
    expect(logger).toHaveBeenCalledTimes(1);
    const msg = logger.mock.calls[0][0] as string;
    expect(msg).toContain('dedup');
    expect(msg).toContain(ENI_CASLANO_A.id);
    expect(msg).toContain(ENI_CASLANO_B.id);
  });

  it('prefers the entry with diesel data when timestamps are equal', () => {
    const sameTs = '2026-04-18T13:43:03.407Z';
    const withDiesel = { ...ENI_CASLANO_A, updatedAt: sameTs, dieselPriceChf: 1.9 };
    const withoutDiesel = { ...ENI_CASLANO_B, updatedAt: sameTs, dieselPriceChf: null };
    const { unique } = dedupStations([withoutDiesel, withDiesel], {
      logger: vi.fn(),
    });
    expect(unique[0]?.id).toBe(withDiesel.id);
  });

  it('merges independent fuel observations when duplicate ids share an address', () => {
    const sameTs = '2026-10-29T12:00:00.000Z';
    const sp95Only = {
      ...ENI_CASLANO_A,
      id: 'sp95-only',
      updatedAt: sameTs,
      dieselPriceChf: null,
      priceStatus: { sp95: 'available', diesel: 'unavailable' },
    };
    const dieselOnly = {
      ...ENI_CASLANO_B,
      id: 'diesel-only',
      updatedAt: sameTs,
      sp95PriceChf: null,
      dieselPriceChf: 1.91,
      priceStatus: { sp95: 'unavailable', diesel: 'available' },
    };
    const { unique } = dedupStations([sp95Only, dieselOnly], { logger: vi.fn() });

    expect(unique).toHaveLength(1);
    expect(unique[0]).toMatchObject({
      sp95PriceChf: ENI_CASLANO_A.sp95PriceChf,
      dieselPriceChf: 1.91,
      priceStatus: { sp95: 'available', diesel: 'available' },
    });
  });

  it('keeps a priced TCS row as the canonical record when it collides with price-less OSM inventory', () => {
    const tcs = {
      id: 'tcs-priced',
      name: 'AVIA',
      address: 'Via Roma 1, 6900 Lugano',
      lat: 46.01,
      lng: 8.95,
      sp95PriceChf: 1.9,
      dieselPriceChf: null,
      updatedAt: null,
      observedAt: '2026-10-29T12:00:00.000Z',
      source: 'tcs-benzinpreis-cloud-function',
    };
    const osm = {
      id: 'osm:node/1',
      name: 'AVIA',
      address: 'Via Roma 1, 6900 Lugano',
      lat: 46.01,
      lng: 8.95,
      sp95PriceChf: null,
      dieselPriceChf: null,
      updatedAt: null,
      observedAt: '2026-10-29T04:17:00.000Z',
      source: 'openstreetmap-amenity-fuel',
      inventorySource: 'openstreetmap-amenity-fuel',
      inventoryId: 'osm:node/1',
      canton: 'TI',
    };
    const { unique } = dedupStations([osm, tcs], { logger: vi.fn() });

    expect(unique).toHaveLength(1);
    expect(unique[0]).toMatchObject({
      id: 'tcs-priced',
      source: 'tcs-benzinpreis-cloud-function',
      sp95PriceChf: 1.9,
      inventorySource: 'openstreetmap-amenity-fuel',
      inventoryId: 'osm:node/1',
      canton: 'TI',
    });
  });

  it('returns a stable id tiebreak when everything else matches', () => {
    const sameTs = '2026-04-18T13:43:03.407Z';
    const a = { ...ENI_CASLANO_A, updatedAt: sameTs, dieselPriceChf: null, id: 'aaa' };
    const b = { ...ENI_CASLANO_B, updatedAt: sameTs, dieselPriceChf: null, id: 'bbb' };
    const resultAB = dedupStations([a, b], { logger: vi.fn() }).unique;
    const resultBA = dedupStations([b, a], { logger: vi.fn() }).unique;
    expect(resultAB[0]?.id).toBe('aaa');
    expect(resultBA[0]?.id).toBe('aaa');
  });

  it('is a no-op for an already-unique list', () => {
    const { unique, removed } = dedupStations([UNIQUE_STATION, ENI_CASLANO_A], {
      logger: vi.fn(),
    });
    expect(unique).toHaveLength(2);
    expect(removed).toHaveLength(0);
  });

  it('collapses the Eni Gondo duplicate observed in prod', () => {
    const gondoA = {
      id: '5GABW402f1nC7TrNr0Uy',
      name: 'Eni Gondo',
      address: 'Simplonstrasse, 3907 Gondo',
      lat: 46.19588101209614,
      lng: 8.139144951049095,
      sp95PriceChf: 1.88,
      dieselPriceChf: null,
      updatedAt: '2026-04-11T13:02:05.996Z',
    };
    const gondoB = {
      id: 'oT9YL2qEn7dAPLL6reGg',
      name: 'Eni Gondo',
      address: 'Simplonstrasse, 3907 Gondo',
      lat: 46.19609,
      lng: 8.13856,
      sp95PriceChf: 1.88,
      dieselPriceChf: null,
      updatedAt: '2026-04-17T11:48:51.553Z',
    };
    const { unique, removed } = dedupStations([gondoA, gondoB], {
      logger: vi.fn(),
    });
    expect(unique).toHaveLength(1);
    // gondoB is newer → wins.
    expect(unique[0]?.id).toBe(gondoB.id);
    expect(removed).toHaveLength(1);
  });
});
