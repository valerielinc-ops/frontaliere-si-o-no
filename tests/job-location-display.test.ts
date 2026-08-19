/**
 * job-location-display — the formatter that stopped job pages printing the
 * canton twice.
 *
 * Every `expect` below that names a city is a pair taken verbatim from
 * `data/jobs/by-crawler/*.json` at origin/main on 2026-08-19, not invented:
 * the fixtures are the defect, so a future "simplification" of the peeling
 * loop fails on the data it was written for rather than on a toy string.
 *
 * NO DATASET IS READ. The module under test imports nothing, so this file runs
 * in a sparse worktree where `data/` does not exist — which is the whole reason
 * `scripts/lib/job-location-display.mjs` does not reuse `services/cantonList.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  KNOWN_CANTON_CODES,
  formatJobLocation,
  jobLocationRedundancy,
  splitJobLocation,
} from '../scripts/lib/job-location-display.mjs';

describe('formatJobLocation', () => {
  it('does not repeat a canton the location already spells in parentheses', () => {
    // The page that opened the bug report:
    // /cerca-lavoro-berna/masterdata-specialista-60-rado-watch-co-ltd-lengnau-be/
    // printed "Rado Watch Co. Ltd. · Lengnau (BE) (BE)".
    expect(formatJobLocation('Lengnau (BE)', 'BE')).toBe('Lengnau (BE)');
    expect(formatJobLocation('Renens (VD)', 'VD')).toBe('Renens (VD)');
    expect(formatJobLocation('Bronschhofen (SG)', 'SG')).toBe('Bronschhofen (SG)');
    expect(formatJobLocation('Zollikofen (BE)', 'BE')).toBe('Zollikofen (BE)');
  });

  it('does not repeat a bare trailing canton code', () => {
    // bachem writes the official municipality name "Stein AG" (Aargau's Stein,
    // as opposed to Stein/AR); 266 jobs carry this shape.
    expect(formatJobLocation('Stein AG', 'AG')).toBe('Stein (AG)');
    expect(formatJobLocation('Chur GR', 'GR')).toBe('Chur (GR)');
  });

  it('does not repeat a canton spelled out in full — the largest class (1,447 jobs)', () => {
    expect(formatJobLocation('Möhlin, Aargau', 'AG')).toBe('Möhlin (AG)');
    expect(formatJobLocation('Frauenfeld, Thurgau', 'TG')).toBe('Frauenfeld (TG)');
    expect(formatJobLocation('Baden-Daettwil, Aargau', 'AG')).toBe('Baden-Daettwil (AG)');
    // Both markers at once — the parenthesised code peels first, then the name.
    expect(formatJobLocation('Möhlin, Aargau (AG)', 'AG')).toBe('Möhlin (AG)');
  });

  it('recognises the canton name in any of the four site languages', () => {
    expect(formatJobLocation('Bellinzona, Tessin', 'TI')).toBe('Bellinzona (TI)');
    expect(formatJobLocation('Lugano, Ticino', 'TI')).toBe('Lugano (TI)');
    expect(formatJobLocation('Sion, Wallis', 'VS')).toBe('Sion (VS)');
    expect(formatJobLocation('Sion, Vallese', 'VS')).toBe('Sion (VS)');
    // Diacritics and case are folded: crawlers scrape three spellings of one name.
    expect(formatJobLocation('Meyrin, GENEVE', 'GE')).toBe('Meyrin (GE)');
    expect(formatJobLocation('Uster, Zuerich', 'ZH')).toBe('Uster (ZH)');
  });

  it('drops a country marker, which never says which canton', () => {
    // c-and-a-schweiz stamps "(CH)" on all 58 of its postings.
    expect(formatJobLocation('Zürich (CH)', 'ZH')).toBe('Zürich (ZH)');
    expect(formatJobLocation('Frauenfeld (CH)', 'TG')).toBe('Frauenfeld (TG)');
    // ...and when the canton field is empty the country marker still goes.
    expect(formatJobLocation('Emmenbrücke (CH)', '')).toBe('Emmenbrücke');
  });

  it('peels more than one marker — CERN writes the city, the canton and the country', () => {
    expect(formatJobLocation('Geneva, GENEVA, Switzerland', 'GE')).toBe('Geneva (GE)');
  });

  it('leaves a clean location exactly as it was', () => {
    expect(formatJobLocation('Zürich', 'ZH')).toBe('Zürich (ZH)');
    expect(formatJobLocation('Lugano', 'TI')).toBe('Lugano (TI)');
    expect(formatJobLocation('Baden-Daettwil', 'AG')).toBe('Baden-Daettwil (AG)');
    expect(formatJobLocation('La Chaux-de-Fonds', 'NE')).toBe('La Chaux-de-Fonds (NE)');
  });

  it('never strips a location down to nothing', () => {
    // "Ticino" as the whole location is a vague location, not a redundant one:
    // removing the marker would leave the reader with no place at all.
    expect(formatJobLocation('Ticino', 'TI')).toBe('Ticino (TI)');
    expect(formatJobLocation('Zug', 'ZG')).toBe('Zug (ZG)');
    expect(formatJobLocation('Bern', 'BE')).toBe('Bern (BE)');
    expect(formatJobLocation('Jura', 'JU')).toBe('Jura (JU)');
  });

  it('refuses to print two contradicting cantons', () => {
    // Real pair: ottos and lidl-svizzera publish "Reinach (AG)" stamped BL
    // (Reinach exists in both). Which half is wrong is a data question —
    // audit-job-locations.mjs adjudicates it — so the formatter prints the
    // employer's own string and appends nothing.
    expect(formatJobLocation('Reinach (AG)', 'BL')).toBe('Reinach (AG)');
    expect(formatJobLocation('Buchs (AG)', 'SG')).toBe('Buchs (AG)');
  });

  it('adopts the location marker when the canton field is empty', () => {
    expect(formatJobLocation('Lengnau (BE)', '')).toBe('Lengnau (BE)');
    expect(formatJobLocation('Stein AG', null)).toBe('Stein (AG)');
  });

  it('degrades safely on junk rather than throwing or emptying', () => {
    expect(formatJobLocation('', 'TI')).toBe('TI');
    expect(formatJobLocation(null, null)).toBe('');
    expect(formatJobLocation(undefined, 'ZZ')).toBe('');
    // A scraped address is not a redundancy — it is passed through untouched
    // for the audit to report, not silently rewritten.
    expect(formatJobLocation('Via al Mulino 22a, 6814 Cadempino', 'TI'))
      .toBe('Via al Mulino 22a, 6814 Cadempino (TI)');
    expect(formatJobLocation('Wetzikon | Ziegelbrücke', 'ZH')).toBe('Wetzikon | Ziegelbrücke (ZH)');
  });

  it('ignores an unknown canton code instead of printing it', () => {
    expect(formatJobLocation('Milano', 'XX')).toBe('Milano');
  });
});

describe('splitJobLocation', () => {
  it('reports which marker it removed, so an audit can group by cause', () => {
    expect(splitJobLocation('Lengnau (BE)', 'BE')).toEqual({
      city: 'Lengnau', canton: 'BE', stripped: ['paren-code'], conflict: false,
    });
    expect(splitJobLocation('Stein AG', 'AG')).toEqual({
      city: 'Stein', canton: 'AG', stripped: ['bare-code'], conflict: false,
    });
    expect(splitJobLocation('Möhlin, Aargau', 'AG')).toEqual({
      city: 'Möhlin', canton: 'AG', stripped: ['canton-name'], conflict: false,
    });
    expect(splitJobLocation('Geneva, GENEVA, Switzerland', 'GE')).toEqual({
      city: 'Geneva', canton: 'GE', stripped: ['country', 'canton-name'], conflict: false,
    });
  });

  it('flags a conflict without rewriting either half', () => {
    expect(splitJobLocation('Reinach (AG)', 'BL')).toEqual({
      city: 'Reinach (AG)', canton: null, stripped: [], conflict: true,
    });
  });
});

describe('jobLocationRedundancy', () => {
  it('is null exactly when there is nothing to report', () => {
    expect(jobLocationRedundancy('Lugano', 'TI')).toBeNull();
    expect(jobLocationRedundancy('', 'TI')).toBeNull();
    expect(jobLocationRedundancy('Lengnau (BE)', 'BE')).toEqual({ redundancy: ['paren-code'], conflict: false });
    expect(jobLocationRedundancy('Reinach (AG)', 'BL')).toEqual({ redundancy: [], conflict: true });
  });
});

describe('KNOWN_CANTON_CODES', () => {
  it('is the 26 cantons, so an audit importing it cannot drift onto a shorter list', () => {
    expect(KNOWN_CANTON_CODES.size).toBe(26);
    for (const code of ['TI', 'ZH', 'BE', 'GE', 'JU', 'AI', 'AR', 'BL', 'BS']) {
      expect(KNOWN_CANTON_CODES.has(code)).toBe(true);
    }
    expect(KNOWN_CANTON_CODES.has('CH')).toBe(false);
  });
});
