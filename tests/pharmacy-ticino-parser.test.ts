import { describe, expect, it, vi } from 'vitest';

import {
  OFCT_REGIONS,
  parsePharmacyListTable,
  buildPharmacyRecords,
  dedupePharmaciesById,
} from '../scripts/lib/pharmacy-ticino-parser.mjs';
import { validatePharmacyList } from '../services/pharmacies/types';

/**
 * Parser for the Ticino pharmacy anagraphic on ofct.ch (#6398 verified
 * source). Fixture mirrors the real `#tabella_lista_farmacie` markup
 * observed on `https://www.ofct.ch/mendrisiotto/` (2026-08-31): a header
 * row followed by data rows, `Località` cell as `{postalCode}  {city}`
 * with a double-space separator.
 */
const FIXTURE_HTML = `
<div class="wrapper">
  <table id='tabella_lista_farmacie' class='d-none d-md-table'>
    <tr><td>Farmacia</td><td>Indirizzo</td><td>Località</td><td>Telefono</td></tr>
    <tr><td>Accademia</td><td>Via Gismonda 6</td><td>6850  Mendrisio</td><td>+41 91 646 12 35</td></tr>
    <tr><td>Bernasconi</td><td>Via San Gottardo 29</td><td>6877  Coldrerio</td><td>+41 91 646 49 22</td></tr>
  </table>
</div>
`;

describe('OFCT_REGIONS', () => {
  it('lists exactly the 4 verified ofct.ch regions (Locarnese excluded, #6398)', () => {
    expect(OFCT_REGIONS.map((r) => r.key).sort()).toEqual(
      ['bellinzonese', 'biasca-e-valli', 'luganese', 'mendrisiotto'].sort(),
    );
    for (const region of OFCT_REGIONS) {
      expect(region.url).toMatch(/^https:\/\/www\.ofct\.ch\//);
    }
  });
});

describe('parsePharmacyListTable', () => {
  it('parses each data row, skipping the header', () => {
    const { rows, skipped } = parsePharmacyListTable(FIXTURE_HTML);
    expect(rows).toHaveLength(2);
    expect(skipped).toBe(0);
    expect(rows[0]).toEqual({
      name: 'Accademia',
      address: 'Via Gismonda 6',
      postalCode: '6850',
      city: 'Mendrisio',
      phone: '+41 91 646 12 35',
    });
    expect(rows[1].city).toBe('Coldrerio');
    expect(rows[1].postalCode).toBe('6877');
  });

  it('returns an empty rows array when the table is missing (structure drift)', () => {
    expect(parsePharmacyListTable('<div>no table here</div>')).toEqual({ rows: [], skipped: 0 });
  });

  it('returns an empty rows array on empty/null input', () => {
    expect(parsePharmacyListTable('')).toEqual({ rows: [], skipped: 0 });
  });

  it('skips a malformed row missing the postal-code/city split and counts it', () => {
    const html = `<table id='tabella_lista_farmacie'>
      <tr><td>Farmacia</td><td>Indirizzo</td><td>Località</td><td>Telefono</td></tr>
      <tr><td>Broken</td><td>Via Ignota 1</td><td>no-postal-code</td><td>+41 91 000 00 00</td></tr>
    </table>`;
    expect(parsePharmacyListTable(html)).toEqual({ rows: [], skipped: 1 });
  });

  it('counts malformed rows even when other rows in the same region parse fine (#6800)', () => {
    const html = `<table id='tabella_lista_farmacie'>
      <tr><td>Farmacia</td><td>Indirizzo</td><td>Località</td><td>Telefono</td></tr>
      <tr><td>Accademia</td><td>Via Gismonda 6</td><td>6850  Mendrisio</td><td>+41 91 646 12 35</td></tr>
      <tr><td>Broken1</td><td>Via Ignota 1</td><td>no-postal-code</td><td>+41 91 000 00 00</td></tr>
      <tr><td>TooFewCells</td><td>Via Ignota 2</td></tr>
      <tr><td>Bernasconi</td><td>Via San Gottardo 29</td><td>6877  Coldrerio</td><td>+41 91 646 49 22</td></tr>
    </table>`;
    const { rows, skipped } = parsePharmacyListTable(html);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name)).toEqual(['Accademia', 'Bernasconi']);
    expect(skipped).toBe(2);
  });
});

describe('buildPharmacyRecords', () => {
  const region = OFCT_REGIONS[0];
  const fetchedAt = '2026-08-31T00:00:00.000Z';
  const { records, skipped } = buildPharmacyRecords(FIXTURE_HTML, region, fetchedAt);

  it('builds Pharmacy-shaped records with a stable slug-based id', () => {
    expect(records).toHaveLength(2);
    expect(skipped).toBe(0);
    expect(records[0]).toMatchObject({
      id: 'ti-accademia-mendrisio',
      name: 'Accademia',
      slug: 'accademia-mendrisio',
      canton: 'Ticino',
      country: 'CH',
      sourceType: 'official',
      sourceUrl: region.url,
      lastVerifiedAt: fetchedAt,
    });
  });

  it('produces a list that passes the Pharmacy schema guard', () => {
    expect(validatePharmacyList(records)).toEqual([]);
  });

  it('forwards the malformed-row skip count from the parser (#6800)', () => {
    const html = `<table id='tabella_lista_farmacie'>
      <tr><td>Farmacia</td><td>Indirizzo</td><td>Località</td><td>Telefono</td></tr>
      <tr><td>Accademia</td><td>Via Gismonda 6</td><td>6850  Mendrisio</td><td>+41 91 646 12 35</td></tr>
      <tr><td>Broken</td><td>Via Ignota 1</td><td>no-postal-code</td><td>+41 91 000 00 00</td></tr>
    </table>`;
    const result = buildPharmacyRecords(html, region, fetchedAt);
    expect(result.records).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });
});

describe('dedupePharmaciesById', () => {
  it('keeps every record when ids are distinct', () => {
    const { deduped, collisions } = dedupePharmaciesById([
      { id: 'ti-a', name: 'A', city: 'Mendrisio' },
      { id: 'ti-b', name: 'B', city: 'Lugano' },
    ]);
    expect(deduped).toHaveLength(2);
    expect(collisions).toBe(0);
  });

  it('drops the second record on an id collision (first wins) and counts it', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = { id: 'ti-accademia-mendrisio', name: 'Accademia', city: 'Mendrisio', address: 'Via A' };
    const second = { id: 'ti-accademia-mendrisio', name: 'Accademia', city: 'Mendrisio', address: 'Via B' };

    const { deduped, collisions } = dedupePharmaciesById([first, second]);

    expect(deduped).toEqual([first]);
    expect(collisions).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('ti-accademia-mendrisio');
    warnSpy.mockRestore();
  });
});
