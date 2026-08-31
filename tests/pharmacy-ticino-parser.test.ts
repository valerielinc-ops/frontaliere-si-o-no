import { describe, expect, it } from 'vitest';

import { OFCT_REGIONS, parsePharmacyListTable, buildPharmacyRecords } from '../scripts/lib/pharmacy-ticino-parser.mjs';
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
    const rows = parsePharmacyListTable(FIXTURE_HTML);
    expect(rows).toHaveLength(2);
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

  it('returns an empty array when the table is missing (structure drift)', () => {
    expect(parsePharmacyListTable('<div>no table here</div>')).toEqual([]);
  });

  it('returns an empty array on empty/null input', () => {
    expect(parsePharmacyListTable('')).toEqual([]);
  });

  it('skips a malformed row missing the postal-code/city split', () => {
    const html = `<table id='tabella_lista_farmacie'>
      <tr><td>Farmacia</td><td>Indirizzo</td><td>Località</td><td>Telefono</td></tr>
      <tr><td>Broken</td><td>Via Ignota 1</td><td>no-postal-code</td><td>+41 91 000 00 00</td></tr>
    </table>`;
    expect(parsePharmacyListTable(html)).toEqual([]);
  });
});

describe('buildPharmacyRecords', () => {
  const region = OFCT_REGIONS[0];
  const fetchedAt = '2026-08-31T00:00:00.000Z';
  const records = buildPharmacyRecords(FIXTURE_HTML, region, fetchedAt);

  it('builds Pharmacy-shaped records with a stable slug-based id', () => {
    expect(records).toHaveLength(2);
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
});
