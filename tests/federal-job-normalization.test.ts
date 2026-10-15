import { describe, expect, it } from 'vitest';
import {
  federalRegionCantons,
  federalWorkplaceFactValue,
  normalizeFederalDepartmentCompany,
  normalizeFederalJobLocation,
  parseFederalWorkplaceAddress,
  resolveFederalWorkplaceAddress,
  resolveFederalWorkplaceLocality,
  resolveSwissLocalityCanton,
} from '../scripts/lib/federal-job-normalization.mjs';

describe('federal job normalization', () => {
  it('strips non-geographic apprenticeship placeholders from federal locations', () => {
    const normalized = normalizeFederalJobLocation('Claro (TI), Lehrbeginn August 2026');

    expect(normalized.location).toBe('Claro (TI)');
    expect(normalized.addressLocality).toBe('Claro');
    expect(normalized.canton).toBe('TI');
  });

  it('preserves plain localities while removing postal codes from addressLocality', () => {
    const normalized = normalizeFederalJobLocation('6593 Claro (TI)');

    expect(normalized.location).toBe('6593 Claro (TI)');
    expect(normalized.addressLocality).toBe('Claro');
    expect(normalized.canton).toBe('TI');
  });

  it('accepts one PLZ-city hyphen without collapsing separator-only values', () => {
    expect(normalizeFederalJobLocation('6593-Claro (TI)')).toEqual({
      location: '6593-Claro (TI)',
      addressLocality: 'Claro',
      canton: 'TI',
    });
    expect(normalizeFederalJobLocation('6593-- (TI)').addressLocality).toBe('6593--');
    expect(normalizeFederalJobLocation('6593--Claro (TI)').addressLocality).toBe('6593--Claro');
  });

  it('reads the workplace locality out of the free-text arbeitsort values the portal really uses', () => {
    // Values observed on the VTG feed (2026-09-29).
    const cases: Array<[string, string]> = [
      ['Chamblon', 'Chamblon'],
      ['Hinwil, Lehrbeginn August 2027', 'Hinwil'],
      ['Lehrbeginn August 2027, Thun', 'Thun'],
      ['Grolley (FR), Lehrbeginn August 2027', 'Grolley'],
      ['Stauffacherstrasse 65, 3003 Bern', 'Bern'],
      ['Emmen<br/>Emmen', 'Emmen'],
      ['Bern &amp; Zimmerwald', 'Bern'],
      ['Payerne und Meiringen', 'Payerne'],
      ['Meiringen (Unterbach)', 'Meiringen'],
      ['Zimmerwald BE', 'Zimmerwald'],
      ['Dübendorf - Im Pikettfall musst du den Standort innerhalb von 60 Minuten erreichen können', 'Dübendorf'],
      ['STANS-OBERDORF / AUSLAND', 'Stans-Oberdorf'],
      // No Swiss workplace: the engine keeps its own location.
      ['Ausland / Kosovo', ''],
      ['Pristina, Kosovo', ''],
      ['Schweiz und Ausland (abhängig von Funktion und Einsatzort)', ''],
      ['', ''],
      // The first segment is a site label, not a place: the workplace is the
      // first segment that is a Swiss locality (or carries a canton marker).
      ["Places d'armes, 1436 Chamblon", 'Chamblon'],
      ['Waffenplatz, Bronschhofen SG', 'Bronschhofen'],
      // A former municipality with no marker is not placed at all.
      ['Bronschhofen', ''],
    ];
    for (const [raw, expected] of cases) {
      expect(resolveFederalWorkplaceLocality(raw), raw).toBe(expected);
    }
  });

  it('places a locality through the caller only where the built-in lists cannot', () => {
    // Bronschhofen (a former municipality) is not placed on its own; a caller
    // that knows the posting's region may place it. A site label is still
    // skipped: the caller is asked about the locality candidates only.
    expect(resolveFederalWorkplaceLocality('Bronschhofen', { isPlaced: (l: string) => l === 'Bronschhofen' })).toBe('Bronschhofen');
    expect(resolveFederalWorkplaceLocality("Places d'armes, 1436 Chamblon", { isPlaced: () => false })).toBe('Chamblon');
    expect(resolveFederalWorkplaceLocality('Ausland / Kosovo', { isPlaced: () => true })).toBe('');
  });

  it('reads the cantons a region facet names, not its first code', () => {
    // Real `region` values of the VTG feed.
    expect([...federalRegionCantons(['Ostschweiz (AI, AR, GL, GR, SG, SH, TG)'])]).toEqual(['AI', 'AR', 'GL', 'GR', 'SG', 'SH', 'TG']);
    expect([...federalRegionCantons(['Genferseeregion (GE, VD, VS)', 'Espace Mittelland (BE, FR, JU, NE, SO)'])])
      .toEqual(['GE', 'VD', 'VS', 'BE', 'FR', 'JU', 'NE', 'SO']);
    expect([...federalRegionCantons(['Tessin (TI)'])]).toEqual(['TI']);
    expect(federalRegionCantons(['Ausland']).size).toBe(0);
  });

  it('places a locality in one canton with the official directory, or not at all', () => {
    const ostschweiz = federalRegionCantons(['Ostschweiz (AI, AR, GL, GR, SG, SH, TG)']);
    const mittelland = federalRegionCantons(['Espace Mittelland (BE, FR, JU, NE, SO)']);
    // Former municipality, absent from the BFS list: the directory has 9552 Bronschhofen in SG.
    expect(resolveSwissLocalityCanton('Bronschhofen', { cantons: ostschweiz })).toBe('SG');
    expect(resolveSwissLocalityCanton('Bronschhofen', { postalCode: '9552' })).toBe('SG');
    // Rüti 8630 is listed in Zürich and St. Gallen: only a region that says Zürich decides.
    expect(resolveSwissLocalityCanton('Rüti', { postalCode: '8630' })).toBe('');
    expect(resolveSwissLocalityCanton('Rüti', { cantons: federalRegionCantons(['Zürich (ZH)']) })).toBe('ZH');
    // Romont exists in BE and FR, both inside the posting's regions.
    expect(resolveSwissLocalityCanton('Romont', {
      cantons: federalRegionCantons(['Genferseeregion (GE, VD, VS)', 'Espace Mittelland (BE, FR, JU, NE, SO)']),
    })).toBe('');
    expect(resolveSwissLocalityCanton('Romont', { postalCode: '1680' })).toBe('FR');
    // "Bremgarten bei Bern" is another locality than "Bremgarten": the VTG
    // posting in region Espace Mittelland is the barracks at 5620 Bremgarten (AG).
    expect(resolveSwissLocalityCanton('Bremgarten', { cantons: mittelland })).toBe('');
    expect(resolveSwissLocalityCanton('Bremgarten', { postalCode: '5620' })).toBe('AG');
    // A CAP the directory does not list with the name (Bern is 3004 there) still fits the name.
    expect(resolveSwissLocalityCanton('Bern', { postalCode: '3003' })).toBe('BE');
    expect(resolveSwissLocalityCanton('Oberdorf', { postalCode: '6370' })).toBe('NW');
    expect(resolveSwissLocalityCanton('Oberdorf')).toBe('');
  });

  it('reads the workplace address of the page facts, and nothing that is not an address', () => {
    // Values of the "Arbeitsort" fact on jobs.admin.ch VTG pages.
    expect(federalWorkplaceFactValue([
      { label: 'Eintrittsdatum', value: 'nach Vereinbarung' },
      { label: 'Arbeitsort', value: 'Amp-Strasse 12, 9552 Bronschhofen' },
    ])).toBe('Amp-Strasse 12, 9552 Bronschhofen');
    expect(federalWorkplaceFactValue([{ label: 'Referenz-Nr.', value: 'JRQ$540-20344' }])).toBe('');
    expect(parseFederalWorkplaceAddress("Places d'armes, 1436 Chamblon")).toEqual({
      streetAddress: "Places d'armes", postalCode: '1436', addressLocality: 'Chamblon', cantonMarker: '',
    });
    expect(parseFederalWorkplaceAddress('Rekrutierungszentrum Rüti, Spitalstrasse 33, 8630 Rüti')).toMatchObject({
      streetAddress: 'Rekrutierungszentrum Rüti, Spitalstrasse 33', postalCode: '8630', addressLocality: 'Rüti',
    });
    expect(parseFederalWorkplaceAddress('Pristina, Kosovo')).toBeNull();
    expect(parseFederalWorkplaceAddress('Bern')).toBeNull();
    expect(resolveFederalWorkplaceAddress('Amp-Strasse 12, 9552 Bronschhofen')).toEqual({
      streetAddress: 'Amp-Strasse 12', postalCode: '9552', addressLocality: 'Bronschhofen', canton: 'SG',
    });
    expect(resolveFederalWorkplaceAddress('Eichacher, 3086 Wald')).toMatchObject({ postalCode: '3086', canton: 'BE' });
    expect(resolveFederalWorkplaceAddress('8630 Rüti')).toBeNull();
    expect(resolveFederalWorkplaceAddress('8630 Rüti', { cantons: ['ZH'] })).toMatchObject({ canton: 'ZH' });
  });

  it('collapses federal department placeholders to the crawler company brand', () => {
    expect(
      normalizeFederalDepartmentCompany(
        'Eidgenössisches Departement für Verteidigung, Bevölkerungsschutz und Sport VBS',
        'Swiss Armed Forces (VTG)',
      ),
    ).toBe('Swiss Armed Forces (VTG)');
  });
});
