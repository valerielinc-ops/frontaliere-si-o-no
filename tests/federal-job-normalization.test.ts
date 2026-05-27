import { describe, expect, it } from 'vitest';
import {
  normalizeFederalDepartmentCompany,
  normalizeFederalJobLocation,
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

  it('collapses federal department placeholders to the crawler company brand', () => {
    expect(
      normalizeFederalDepartmentCompany(
        'Eidgenössisches Departement für Verteidigung, Bevölkerungsschutz und Sport VBS',
        'Swiss Armed Forces (VTG)',
      ),
    ).toBe('Swiss Armed Forces (VTG)');
  });
});
