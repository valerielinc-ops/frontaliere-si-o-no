import { describe, expect, it } from 'vitest';
import {
  buildProfessionEvergreenTopics,
  buildComuneEvergreenTopics,
  buildStructuralEvergreenTopics,
  resolveComuneCanton,
} from '../scripts/lib/evergreen-topic-generator.mjs';
import { MUNICIPALITIES } from '../data/municipalities.ts';

describe('buildProfessionEvergreenTopics', () => {
  const topics = buildProfessionEvergreenTopics();

  it('produces one candidate per profession, all shaped {keyword, angle}', () => {
    expect(topics.length).toBeGreaterThan(50);
    for (const t of topics) {
      expect(typeof t.keyword).toBe('string');
      expect(t.keyword.length).toBeGreaterThan(0);
      expect(typeof t.angle).toBe('string');
      expect(t.angle.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate keywords', () => {
    const keywords = topics.map((t) => t.keyword);
    expect(new Set(keywords).size).toBe(keywords.length);
  });

  it('never leaks a raw slash or trailing parenthetical into the keyword', () => {
    for (const t of topics) {
      expect(t.keyword).not.toMatch(/\//);
      expect(t.keyword).not.toMatch(/[()]/);
    }
  });

  it('does not trip the permesso-g-b saturated family (no bare "b" token alongside permesso+g)', () => {
    for (const t of topics) {
      const text = `${t.keyword} ${t.angle}`.toLowerCase();
      const hasPermessoAndG = /\bpermess[oi]\b/.test(text) && /\bg\b/.test(text);
      const hasBareB = /\bb\b/.test(text);
      expect(hasPermessoAndG && hasBareB).toBe(false);
    }
  });
});

describe('resolveComuneCanton', () => {
  const byName = (name: string) => MUNICIPALITIES.find((m) => m.name === name);

  it('does not regress the original 3-province mapping (CO/VA/VB, SO, AO/VC)', () => {
    expect(resolveComuneCanton({ province: 'CO' })).toBe('Ticino');
    expect(resolveComuneCanton({ province: 'VA' })).toBe('Ticino');
    expect(resolveComuneCanton({ province: 'VB' })).toBe('Ticino');
    expect(resolveComuneCanton({ province: 'SO' })).toBe('Grigioni');
    expect(resolveComuneCanton({ province: 'AO' })).toBe('Vallese');
    expect(resolveComuneCanton({ province: 'VC' })).toBe('Vallese');
  });

  it('resolves all 9 Monza e Brianza (MB) comuni to Ticino via border-crossing proximity', () => {
    const mb = MUNICIPALITIES.filter((m) => m.province === 'MB');
    expect(mb.length).toBe(9);
    for (const m of mb) {
      expect(resolveComuneCanton(m)).toBe('Ticino');
    }
  });

  it('resolves most BG/BS/TN/BZ comuni to Grigioni now that real Grigioni crossings exist (Umbrail, Munt La Schera, Martina-Nauders, Samnaun-Spiss, Forcola di Livigno) — except Rabbi (TN), still too far', () => {
    // Was "excludes every BG/BS/TN/BZ comune" until the nationwide border-crossing
    // data PR added Graubünden's first-ever entries: before that, this dataset had
    // zero canton-'GR' crossings, so this fallback could only ever resolve Ticino/
    // Vallese (see the original comment on PROVINCE_CANTON/resolveCantonByBorderProximity).
    // Alta Val Venosta (BZ) sits right on the Val Müstair corridor the new Grigioni
    // crossings cover — Tubre is 11.8km from Umbrail alone — so most of this batch
    // now resolves correctly, same distance-based logic as always, just with real
    // Grigioni reference points to compare against for the first time.
    const farProvinces = ['BG', 'BS', 'TN', 'BZ'];
    const far = MUNICIPALITIES.filter((m) => farProvinces.includes(m.province));
    expect(far.length).toBe(26); // 3 + 11 + 2 + 10
    const resolved = far.filter((m) => resolveComuneCanton(m));
    const unresolved = far.filter((m) => !resolveComuneCanton(m));
    for (const m of resolved) {
      expect(resolveComuneCanton(m)).toBe('Grigioni');
    }
    expect(unresolved.map((m) => m.name)).toEqual(['Rabbi']);
  });

  it('resolves Tubre (BZ) to Grigioni — 11.8km from Umbrail (Giogo di Santa Maria), the nearest real Grigioni crossing added alongside this test', () => {
    const tubre = byName('Tubre');
    expect(tubre).toBeTruthy();
    expect(resolveComuneCanton(tubre)).toBe('Grigioni');
  });

  it('resolves a concrete MB comune (Meda) to Ticino with a real margin over the nearest Vallese crossing', () => {
    const meda = byName('Meda');
    expect(meda).toBeTruthy();
    expect(resolveComuneCanton(meda)).toBe('Ticino');
  });

  it('excludes a synthetic comune sitting roughly equidistant between a Ticino and a Vallese crossing (ambiguous, not force-assigned)', () => {
    // Midpoint between Camedo (TI, Re-Centovalli) and Sempione (VS,
    // Iselle-Gondo): ~14km from the nearest TI crossing but only ~11km
    // farther to the nearest VS one — well under the confidence margin,
    // so this must stay unresolved rather than default to "nearest wins".
    const ambiguous = { province: 'ZZ', lat: 46.173, lng: 8.45 };
    expect(resolveComuneCanton(ambiguous)).toBeFalsy();
  });

  it('excludes a comune with no usable coordinates instead of throwing', () => {
    expect(resolveComuneCanton({ province: 'ZZ' })).toBeFalsy();
    expect(resolveComuneCanton(undefined)).toBeFalsy();
  });

  it('never resolves any of the 518 comuni to a canton outside Ticino/Grigioni/Vallese', () => {
    for (const m of MUNICIPALITIES) {
      const canton = resolveComuneCanton(m);
      if (canton) expect(['Ticino', 'Grigioni', 'Vallese']).toContain(canton);
    }
  });
});

describe('buildComuneEvergreenTopics', () => {
  const topics = buildComuneEvergreenTopics();

  it('produces one candidate per selected comune, all shaped {keyword, angle}', () => {
    expect(topics.length).toBeGreaterThan(25);
    for (const t of topics) {
      expect(typeof t.keyword).toBe('string');
      expect(t.keyword.length).toBeGreaterThan(0);
      expect(typeof t.angle).toBe('string');
      expect(t.angle.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate keywords', () => {
    const keywords = topics.map((t) => t.keyword);
    expect(new Set(keywords).size).toBe(keywords.length);
  });

  it('only assigns a canton for comuni from an unambiguous province', () => {
    for (const t of topics) {
      expect(t.keyword).toMatch(/lavorare in (Ticino|Grigioni|Vallese)|^trasferirsi a /);
    }
  });

  // Was: "caps candidates per canton bucket instead of exploding to all 518
  // comuni", asserting `topics.length <= 85` (40 Ticino + 25 Grigioni + 20
  // Vallese). That cap is gone, and the assertion went with it — it pinned the
  // exact number that starved the `frontaliere` section: the pool saturated at
  // `checked=382 pool=382`, 32 dispatch out of 32, and publication fell from 22
  // articles a day to 4. What the test was really defending is still defended
  // below, and more precisely: not "at most 85", but "only comuni within
  // commuting distance", which is the reason a bound exists at all.
  it('selects only comuni within commuting distance, never all 518', () => {
    const MAX_KM = 30; // COMUNE_MAX_DISTANCE_KM in evergreen-topic-generator.mjs
    const computed = buildComuneEvergreenTopics(MUNICIPALITIES as never);

    // Still a real bound, and it must bite against the RESOLVED count, not the
    // row count: 518 rows resolve to 506 cantons, so `< MUNICIPALITIES.length`
    // would also pass with no cap at all (506 < 518) — it asserted nothing.
    const resolved = MUNICIPALITIES.filter((m) => m?.name && resolveComuneCanton(m)).length;
    expect(computed.length).toBeLessThan(resolved);

    const selected = new Set(computed.map((t) => t.keyword));
    // `typeof === 'number'` mirrors the implementation, which promises to drop
    // a comune with no usable distanceKm rather than sort it as if it were at
    // the border. Without it a row with `distanceKm: undefined` falls out of
    // BOTH lists and the count assertion below still passes — the promise
    // would go unobserved. Latent today (0 such rows) but not free.
    const usable = (m: (typeof MUNICIPALITIES)[number]) =>
      m?.name && resolveComuneCanton(m) && typeof m.distanceKm === 'number';
    const withinRadius = MUNICIPALITIES.filter((m) => usable(m) && m.distanceKm <= MAX_KM);
    const beyondRadius = MUNICIPALITIES.filter((m) => usable(m) && m.distanceKm > MAX_KM);
    expect(withinRadius.length + beyondRadius.length).toBe(
      MUNICIPALITIES.filter((m) => m?.name && resolveComuneCanton(m)).length,
    );

    expect(withinRadius.length).toBeGreaterThan(0);
    expect(beyondRadius.length).toBeGreaterThan(0);
    expect(selected.size).toBe(withinRadius.length);

    for (const m of beyondRadius) {
      const canton = resolveComuneCanton(m);
      expect(selected.has(`vivere a ${m.name} e lavorare in ${canton} da frontaliere`)).toBe(false);
    }
  });

  it('applies the same distance bar in every canton, not a per-canton quota', () => {
    // The defect in the old count cap: at 40/25/20 the real bar sat around 5km
    // in Ticino but around 20km in Vallese, so identical keywords were kept or
    // dropped at four times the distance depending only on how many comuni
    // happened to share their canton. Every canton must now keep everything
    // inside the radius — a shortfall in any one of them means a quota is back.
    const MAX_KM = 30;
    const computed = buildComuneEvergreenTopics(MUNICIPALITIES as never);

    const expectedPerCanton = new Map<string, number>();
    for (const m of MUNICIPALITIES) {
      const canton = resolveComuneCanton(m);
      if (!canton || !m?.name || typeof m.distanceKm !== 'number') continue;
      if (m.distanceKm > MAX_KM) continue;
      expectedPerCanton.set(canton, (expectedPerCanton.get(canton) ?? 0) + 1);
    }

    const actualPerCanton = new Map<string, number>();
    for (const t of computed) {
      const canton = /lavorare in (\w+) da frontaliere$/.exec(t.keyword)?.[1];
      if (canton) actualPerCanton.set(canton, (actualPerCanton.get(canton) ?? 0) + 1);
    }

    expect(expectedPerCanton.size).toBeGreaterThan(1);
    for (const [canton, expected] of expectedPerCanton) {
      expect(actualPerCanton.get(canton) ?? 0).toBe(expected);
    }
  });

  it('keeps the structural pool far above the level that saturated the section', () => {
    // 7045b166 halved the structural pool (310 -> 155) with CI green, because
    // nothing asserted its size; the runtime pool went 537 -> 382 and
    // `frontaliere` saturated outright. This is the missing observer: the floor
    // sits above BOTH rejected values and below the 516 measured here, so a
    // return to any per-canton quota trips it. Lower it only with a measurement.
    expect(buildStructuralEvergreenTopics().length).toBeGreaterThanOrEqual(400);
  });
});

describe('buildStructuralEvergreenTopics', () => {
  it('merges profession + comune candidates with no cross-source duplicate keywords', () => {
    const topics = buildStructuralEvergreenTopics();
    const keywords = topics.map((t) => t.keyword);
    expect(new Set(keywords).size).toBe(keywords.length);
    expect(topics.length).toBe(
      buildProfessionEvergreenTopics().length + buildComuneEvergreenTopics().length
    );
  });
});
