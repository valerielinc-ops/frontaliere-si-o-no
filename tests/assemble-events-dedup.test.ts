/**
 * Cross-source dedup + Italian frontier comuni attachment gate for the
 * events assembler (issue #3125). scripts/assemble-events-dataset.mjs merges
 * per-source slices (data/events/by-source/<key>.json) by `event.id`
 * (last-write-wins), then this SECOND pass collapses the same physical event
 * when two or more different sources (tio-agenda / guidle / myswitzerland)
 * index it independently under a different id — OR (issue #3744) when the
 * SAME source indexes its own event twice under a different raw id/URL, as
 * long as the two records also carry near-identical `geo` coordinates.
 */
import { describe, it, expect } from 'vitest';
import {
  dedupeFuzzy,
  eventRichnessScore,
  pickRichestEvent,
  attachItalianFrontierComuni,
} from '../scripts/assemble-events-dataset.mjs';

function ev(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'tio-agenda:1',
    title: 'Sagra del Paese',
    startDate: '2026-08-01',
    comune: 'Lugano',
    sourceKey: 'tio-agenda',
    ...overrides,
  };
}

describe('eventRichnessScore', () => {
  it('counts populated optional fields only', () => {
    expect(eventRichnessScore(ev())).toBe(0);
    expect(
      eventRichnessScore(
        ev({ description: 'A lovely village fair.', imageUrl: 'https://x/y.jpg', venue: 'Piazza Grande' }),
      ),
    ).toBe(3);
  });

  it('treats empty string / empty object / empty array as NOT populated', () => {
    expect(eventRichnessScore(ev({ description: '  ', address: {}, price: undefined }))).toBe(0);
  });

  it('a populated price object counts as one populated field', () => {
    expect(eventRichnessScore(ev({ price: { amount: 10, currency: 'CHF', isFree: false } }))).toBe(1);
  });
});

describe('pickRichestEvent', () => {
  it('keeps the record with the higher richness score', () => {
    const thin = ev({ id: 'tio-agenda:1', sourceKey: 'tio-agenda' });
    const rich = ev({
      id: 'guidle:abc',
      sourceKey: 'guidle',
      description: 'Full description of the event with plenty of detail.',
      imageUrl: 'https://guidle.example/photo.jpg',
      price: { amount: 0, currency: 'CHF', isFree: true },
    });
    expect(pickRichestEvent([thin, rich])).toBe(rich);
    expect(pickRichestEvent([rich, thin])).toBe(rich); // order-independent
  });

  it('breaks a richness tie via SOURCE_PRIORITY (tio-agenda > guidle > myswitzerland)', () => {
    const fromGuidle = ev({ id: 'guidle:1', sourceKey: 'guidle' });
    const fromTio = ev({ id: 'tio-agenda:1', sourceKey: 'tio-agenda' });
    const fromMySwitzerland = ev({ id: 'myswitzerland:1', sourceKey: 'myswitzerland' });
    expect(pickRichestEvent([fromGuidle, fromTio])).toBe(fromTio);
    expect(pickRichestEvent([fromMySwitzerland, fromGuidle])).toBe(fromGuidle);
    expect(pickRichestEvent([fromMySwitzerland, fromTio, fromGuidle])).toBe(fromTio);
  });

  it('falls back to the lexicographically smaller id when source+score both tie', () => {
    const a = ev({ id: 'guidle:aaa', sourceKey: 'guidle' });
    const b = ev({ id: 'guidle:bbb', sourceKey: 'guidle' });
    expect(pickRichestEvent([b, a])).toBe(a);
  });
});

describe('dedupeFuzzy', () => {
  it('collapses two near-duplicate events from different sources into one', () => {
    const fromTio = ev({ id: 'tio-agenda:100', sourceKey: 'tio-agenda' });
    const fromGuidle = ev({
      id: 'guidle:xyz',
      sourceKey: 'guidle',
      title: 'Sagra del Paese', // identical after normalization
      startDate: '2026-08-01',
      comune: 'Lugano',
      description: 'Traditional village festival with food and music.',
    });
    const { events, mergedAway } = dedupeFuzzy([fromTio, fromGuidle]);
    expect(events).toHaveLength(1);
    expect(mergedAway).toBe(1);
    // The richer (guidle, has a description) record wins.
    expect(events[0].id).toBe('guidle:xyz');
  });

  it('is diacritic/case-insensitive on the title (normalizeText)', () => {
    const fromTio = ev({ id: 'tio-agenda:1', sourceKey: 'tio-agenda', title: 'Festa dèll Uva' });
    const fromGuidle = ev({ id: 'guidle:1', sourceKey: 'guidle', title: 'FESTA DELL UVA' });
    const { events, mergedAway } = dedupeFuzzy([fromTio, fromGuidle]);
    expect(mergedAway).toBe(1);
    expect(events).toHaveLength(1);
  });

  it('does NOT collapse events with the same title but a different startDate', () => {
    const first = ev({ id: 'tio-agenda:1', sourceKey: 'tio-agenda', startDate: '2026-08-01' });
    const second = ev({ id: 'guidle:1', sourceKey: 'guidle', startDate: '2026-08-08' });
    const { events, mergedAway } = dedupeFuzzy([first, second]);
    expect(events).toHaveLength(2);
    expect(mergedAway).toBe(0);
  });

  it('does NOT collapse events with the same title/date but a different comune', () => {
    const first = ev({ id: 'tio-agenda:1', sourceKey: 'tio-agenda', comune: 'Lugano' });
    const second = ev({ id: 'guidle:1', sourceKey: 'guidle', comune: 'Locarno' });
    const { events, mergedAway } = dedupeFuzzy([first, second]);
    expect(events).toHaveLength(2);
    expect(mergedAway).toBe(0);
  });

  it('does NOT collapse a same-source collision without a geo match (only cross-source or geo-matched same-source groups are merged)', () => {
    // Real observed shape: two DIFFERENT events from the same crawler share a
    // generic title and both region-resolved to the same fallback comune,
    // with no geo on either side. Merging these would silently drop a
    // genuine event, so a same-source group without a geo match is left
    // untouched even when the fuzzy key collides.
    const first = ev({ id: 'tio-agenda:1', sourceKey: 'tio-agenda', venue: 'Piazza A' });
    const second = ev({ id: 'tio-agenda:2', sourceKey: 'tio-agenda', venue: 'Piazza B' });
    const { events, mergedAway } = dedupeFuzzy([first, second]);
    expect(events).toHaveLength(2);
    expect(mergedAway).toBe(0);
  });

  it('does NOT collapse a same-source collision when only one side has geo', () => {
    const first = ev({
      id: 'tio-agenda:1',
      sourceKey: 'tio-agenda',
      venue: 'Piazza A',
      geo: { lat: 46.0037, lng: 8.9511 },
    });
    const second = ev({ id: 'tio-agenda:2', sourceKey: 'tio-agenda', venue: 'Piazza B' });
    const { events, mergedAway } = dedupeFuzzy([first, second]);
    expect(events).toHaveLength(2);
    expect(mergedAway).toBe(0);
  });

  it('does NOT collapse a same-source collision when geo coordinates are far apart (> tolerance)', () => {
    const first = ev({
      id: 'tio-agenda:1',
      sourceKey: 'tio-agenda',
      venue: 'Piazza A',
      geo: { lat: 46.0037, lng: 8.9511 }, // Lugano
    });
    const second = ev({
      id: 'tio-agenda:2',
      sourceKey: 'tio-agenda',
      venue: 'Piazza B',
      geo: { lat: 46.1712, lng: 8.7955 }, // Bellinzona, ~20km away
    });
    const { events, mergedAway } = dedupeFuzzy([first, second]);
    expect(events).toHaveLength(2);
    expect(mergedAway).toBe(0);
  });

  it('collapses a same-source collision when geo coordinates match exactly (issue #3744)', () => {
    // Real observed shape: myswitzerland indexed "Heididorf Saisoneröffnung"
    // twice under two different objectIDs, same startDate/comune and EXACT
    // geo coordinates — the by-id merge never catches it (different ids) and
    // the cross-source condition never catches it either (same sourceKey).
    const geo = { lat: 47.017265, lng: 9.5443047 };
    const first = ev({
      id: 'myswitzerland:objA',
      sourceKey: 'myswitzerland',
      title: 'Heididorf Saisoneröffnung',
      comune: 'Maienfeld',
      geo,
    });
    const second = ev({
      id: 'myswitzerland:objB',
      sourceKey: 'myswitzerland',
      title: 'Heididorf Saisoneröffnung',
      comune: 'Maienfeld',
      geo: { ...geo },
      description: 'Richer description on this duplicate.',
    });
    const { events, mergedAway } = dedupeFuzzy([first, second]);
    expect(events).toHaveLength(1);
    expect(mergedAway).toBe(1);
    // Richer (has description) record wins.
    expect(events[0].id).toBe('myswitzerland:objB');
  });

  it('collapses a same-source collision when geo coordinates are within the ~50m tolerance but not exact', () => {
    const first = ev({
      id: 'myswitzerland:objA',
      sourceKey: 'myswitzerland',
      title: 'Heididorf Saisoneröffnung',
      comune: 'Maienfeld',
      geo: { lat: 47.017265, lng: 9.5443047 },
    });
    // ~10m latitude offset — same physical venue, minor geocoding jitter.
    const second = ev({
      id: 'myswitzerland:objB',
      sourceKey: 'myswitzerland',
      title: 'Heididorf Saisoneröffnung',
      comune: 'Maienfeld',
      geo: { lat: 47.017355, lng: 9.5443047 },
    });
    const { events, mergedAway } = dedupeFuzzy([first, second]);
    expect(events).toHaveLength(1);
    expect(mergedAway).toBe(1);
  });

  it('does not chain unrelated same-source venues past the geo tolerance (diameter must stay bounded, not just consecutive links)', () => {
    // Regression for a chain-based clustering bug (caught in PR review): three
    // same-source records spaced ~40m apart along a line — A-B ~40m,
    // B-C ~40m, but A-C ~80m, past the 50m tolerance. A clustering rule that
    // only requires "close to ANY existing cluster member" would incorrectly
    // chain all three into one record even though the two endpoints are
    // clearly two different venues — exactly the false-positive this
    // same-source path exists to avoid.
    const latPerMeter = 1 / 111194.926645; // matches haversineKm's R=6371km model
    const base = 46.0;
    const a = ev({
      id: 'myswitzerland:a',
      sourceKey: 'myswitzerland',
      title: 'Mercatino di Primavera',
      comune: 'Bellinzona',
      geo: { lat: base, lng: 8.9 },
    });
    const b = ev({
      id: 'myswitzerland:b',
      sourceKey: 'myswitzerland',
      title: 'Mercatino di Primavera',
      comune: 'Bellinzona',
      geo: { lat: base + 40 * latPerMeter, lng: 8.9 },
    });
    const c = ev({
      id: 'myswitzerland:c',
      sourceKey: 'myswitzerland',
      title: 'Mercatino di Primavera',
      comune: 'Bellinzona',
      geo: { lat: base + 80 * latPerMeter, lng: 8.9 },
    });
    const { events, mergedAway } = dedupeFuzzy([a, b, c]);
    // A and B (40m apart) collapse; C (80m from A, past tolerance) must NOT
    // be swept in just because it is within tolerance of B alone.
    expect(events).toHaveLength(2);
    expect(mergedAway).toBe(1);
    expect(events.some((e) => e.id === 'myswitzerland:c')).toBe(true);
  });

  it('leaves a singleton group untouched', () => {
    const only = ev();
    const { events, mergedAway } = dedupeFuzzy([only]);
    expect(events).toEqual([only]);
    expect(mergedAway).toBe(0);
  });

  it('collapses a 3-way cross-source collision to exactly one record', () => {
    const a = ev({ id: 'tio-agenda:1', sourceKey: 'tio-agenda' });
    const b = ev({ id: 'guidle:1', sourceKey: 'guidle' });
    const c = ev({ id: 'myswitzerland:1', sourceKey: 'myswitzerland' });
    const { events, mergedAway } = dedupeFuzzy([a, b, c]);
    expect(events).toHaveLength(1);
    expect(mergedAway).toBe(2);
    expect(events[0].id).toBe('tio-agenda:1'); // equal score -> SOURCE_PRIORITY winner
  });
});

describe('attachItalianFrontierComuni', () => {
  it('attaches nearby Italian comuni to a geo-tagged event with none set yet', () => {
    // Chiasso-area coordinates, right at the CH/IT border.
    const chiasso = ev({ geo: { lat: 45.8434, lng: 9.0294 } });
    const attached = attachItalianFrontierComuni([chiasso]);
    expect(attached).toBe(1);
    expect(chiasso.italianFrontierComuni.length).toBeGreaterThan(0);
  });

  it('does nothing for an event without geo', () => {
    const noGeo = ev();
    const attached = attachItalianFrontierComuni([noGeo]);
    expect(attached).toBe(0);
    expect(noGeo.italianFrontierComuni).toBeUndefined();
  });

  it('does not recompute when a crawler already set italianFrontierComuni (even to [])', () => {
    const already = ev({ geo: { lat: 45.8434, lng: 9.0294 }, italianFrontierComuni: [] });
    const attached = attachItalianFrontierComuni([already]);
    expect(attached).toBe(0);
    expect(already.italianFrontierComuni).toEqual([]);
  });

  it('leaves italianFrontierComuni unset when geo is far from the Italian border', () => {
    // Zurich-area coordinates — nowhere near the Italian border.
    const zurich = ev({ geo: { lat: 47.3769, lng: 8.5417 } });
    const attached = attachItalianFrontierComuni([zurich]);
    expect(attached).toBe(0);
    expect(zurich.italianFrontierComuni).toBeUndefined();
  });
});
