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

  it('caps candidates per canton bucket instead of exploding to all 518 comuni', () => {
    // 40 Ticino + 25 Grigioni + 20 Vallese, one candidate each = 85 max
    expect(topics.length).toBeLessThanOrEqual(85);
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
