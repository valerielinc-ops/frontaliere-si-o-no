import { describe, expect, it } from 'vitest';
import {
  normalizeFederalDepartmentCompany,
  normalizeFederalJobLocation,
  resolveFederalWorkplaceLocality,
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
    ];
    for (const [raw, expected] of cases) {
      expect(resolveFederalWorkplaceLocality(raw), raw).toBe(expected);
    }
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
