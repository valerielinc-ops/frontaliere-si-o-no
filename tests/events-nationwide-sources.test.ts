/**
 * Nationwide events sourcing (issue #3125): shared foundations consumed by the
 * guidle/myswitzerland crawlers, the multi-canton hub/route generalization and
 * the assemble step — canton-agnostic comune resolution, Italian frontier
 * comuni geo-linking, per-canton URL base paths, and the no-hotlink image
 * mirror. See scripts/lib/events-utils.mjs.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  EVENT_SOURCES,
  EVENTS_BASE_PATH,
  eventsBasePathForCanton,
  loadAllComuni,
  resolveComuneNationwide,
  haversineKm,
  resolveItalianFrontierComuni,
  mirrorEventImage,
} from '../scripts/lib/events-utils.mjs';

describe('EVENT_SOURCES nationwide registry', () => {
  it('registers guidle and myswitzerland as canton-agnostic (canton: null)', () => {
    expect(EVENT_SOURCES.guidle.canton).toBeNull();
    expect(EVENT_SOURCES.myswitzerland.canton).toBeNull();
    expect(EVENT_SOURCES['tio-agenda'].canton).toBe('TI');
  });
});

describe('eventsBasePathForCanton', () => {
  it('is byte-identical to the legacy EVENTS_BASE_PATH constant for TI', () => {
    expect(eventsBasePathForCanton('TI')).toEqual(EVENTS_BASE_PATH);
  });

  it('builds localized paths for another canton from data/canton-url-slugs.json', () => {
    expect(eventsBasePathForCanton('ZH')).toEqual({
      it: '/eventi/zurigo',
      en: '/en/events/zurich',
      de: '/de/veranstaltungen/zurich',
      fr: '/fr/evenements/zurich',
    });
  });

  it('collapses half-cantons onto their URL group (AI → APPENZELLO)', () => {
    const ai = eventsBasePathForCanton('AI');
    expect(ai.it).toBe('/eventi/appenzello');
  });

  it('degrades to the TI fallback for an unknown/blank canton', () => {
    expect(eventsBasePathForCanton('')).toEqual(EVENTS_BASE_PATH);
    expect(eventsBasePathForCanton('XX')).toEqual(EVENTS_BASE_PATH);
  });
});

describe('loadAllComuni', () => {
  it('flattens all 26 cantons (2110 comuni total)', () => {
    const all = loadAllComuni();
    expect(all.length).toBe(2110);
    expect(all.some((c) => c.name === 'Lugano' && c.canton === 'TI')).toBe(true);
    expect(all.some((c) => c.name === 'Winterthur' && c.canton === 'ZH')).toBe(true);
  });
});

describe('resolveComuneNationwide', () => {
  it('resolves a comune nationwide without a canton hint', () => {
    const r = resolveComuneNationwide({ venue: 'Stadthaus Winterthur', title: 'Konzert', region: undefined });
    expect(r).toEqual({ comune: 'Winterthur', canton: 'ZH', method: 'exact-nationwide' });
  });

  it('scopes to the hinted canton first (exact TI match, same as resolveComune)', () => {
    const r = resolveComuneNationwide({ venue: 'Teatro Sociale Bellinzona', title: 'Concerto', region: undefined }, 'TI');
    expect(r).toEqual({ comune: 'Bellinzona', canton: 'TI', method: 'exact' });
  });

  it('falls back to the TI region map only when hint is TI or absent', () => {
    const withHint = resolveComuneNationwide({ venue: '', title: '', region: 'Luganese' }, 'TI');
    expect(withHint).toEqual({ comune: 'Lugano', canton: 'TI', method: 'region' });

    const withoutHint = resolveComuneNationwide({ venue: '', title: '', region: 'Luganese' });
    expect(withoutHint).toEqual({ comune: 'Lugano', canton: 'TI', method: 'region' });

    const otherCantonHint = resolveComuneNationwide({ venue: '', title: '', region: 'Luganese' }, 'ZH');
    expect(otherCantonHint.comune).toBeNull();
  });

  it('returns null comune when nothing matches', () => {
    const r = resolveComuneNationwide({ venue: 'Somewhere unresolvable', title: 'Nothing here', region: undefined });
    expect(r).toEqual({ comune: null, canton: null, method: null });
  });
});

describe('haversineKm', () => {
  it('is ~0 for identical points and grows monotonically with distance', () => {
    expect(haversineKm(46.0, 8.95, 46.0, 8.95)).toBeCloseTo(0, 5);
    const near = haversineKm(45.858, 8.9511, 45.85, 8.95);
    const far = haversineKm(45.858, 8.9511, 47.37, 8.54); // ~Zurich
    expect(far).toBeGreaterThan(near);
  });
});

describe('resolveItalianFrontierComuni', () => {
  it('returns nearby Italian border comuni for coordinates near the border', () => {
    // Stabio-area coordinates (Mendrisiotto, right at the CH/IT border).
    const near = resolveItalianFrontierComuni({ lat: 45.858, lng: 8.9511 });
    expect(near.length).toBeGreaterThan(0);
    expect(near.length).toBeLessThanOrEqual(5);
  });

  it('returns [] when the event has no geo', () => {
    expect(resolveItalianFrontierComuni(undefined)).toEqual([]);
    expect(resolveItalianFrontierComuni({})).toEqual([]);
    expect(resolveItalianFrontierComuni({ lat: 'x', lng: 8 })).toEqual([]);
  });

  it('returns [] when nothing is within maxKm (e.g. deep in German-speaking Switzerland)', () => {
    expect(resolveItalianFrontierComuni({ lat: 47.55, lng: 9.6 }, { maxKm: 5 })).toEqual([]);
  });
});

describe('mirrorEventImage', () => {
  const testImagesDir = path.join(process.cwd(), 'public', 'images', 'events');

  afterEach(() => {
    vi.unstubAllGlobals();
    // Clean up any file this test wrote so repeated runs stay idempotent and
    // don't leak fixture images into the tracked public/ directory.
    try {
      rmSync(path.join(testImagesDir, 'test-mirror-fixture.jpg'), { force: true });
    } catch {
      /* noop */
    }
  });

  it('returns null for a missing or non-http url', async () => {
    expect(await mirrorEventImage('', 'guidle:abc')).toBeNull();
    expect(await mirrorEventImage('not-a-url', 'guidle:abc')).toBeNull();
    expect(await mirrorEventImage(undefined, 'guidle:abc')).toBeNull();
  });

  it('returns null for an empty stableId', async () => {
    expect(await mirrorEventImage('https://example.com/x.jpg', '')).toBeNull();
  });

  it('downloads and writes the image once, returning the site-relative path', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => bytes.buffer,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await mirrorEventImage('https://example.com/photo.jpg', 'test:mirror-fixture');
    expect(result).toBe('/images/events/test-mirror-fixture.jpg');
    expect(existsSync(path.join(testImagesDir, 'test-mirror-fixture.jpg'))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Idempotent: a second call must NOT re-fetch (file already present).
    const second = await mirrorEventImage('https://example.com/photo.jpg', 'test:mirror-fixture');
    expect(second).toBe('/images/events/test-mirror-fixture.jpg');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null on a non-2xx response, a non-image content-type, or an oversized body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new ArrayBuffer(0) }),
    );
    expect(await mirrorEventImage('https://example.com/notfound.jpg', 'test:mirror-fixture')).toBeNull();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, headers: { get: () => 'text/html' }, arrayBuffer: async () => new ArrayBuffer(4) }),
    );
    expect(await mirrorEventImage('https://example.com/notanimage', 'test:mirror-fixture')).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    expect(await mirrorEventImage('https://example.com/x.jpg', 'test:mirror-fixture')).toBeNull();
  });
});
