import { describe, expect, it } from 'vitest';
import dataset from '../data/pharmacy-duties-ticino.json';
import pharmacies from '../data/pharmacies-ticino.json';
import { getRuntimeDutyState, publicDutiesForRegion } from '../services/pharmacies/duties';
import { validatePharmacyDutiesDataset } from '../services/pharmacies/types';

describe('Ticino duty dataset', () => {
  it('matches the duty schema and only references known pharmacies', () => {
    expect(validatePharmacyDutiesDataset(dataset)).toEqual([]);
    const ids = new Set(pharmacies.pharmacies.map((pharmacy) => pharmacy.id));
    expect(dataset.duties.every((duty) => ids.has(duty.pharmacyId))).toBe(true);
    expect(new Set(dataset.duties.map((duty) => duty.coverageName))).toEqual(new Set(['Mendrisiotto', 'Luganese', 'Bellinzonese', 'Biasca e Valli']));
  });

  it('does not expose expired intervals as current after the page remains open', () => {
    const duty = dataset.duties[0];
    const beforeEnd = new Date(Date.parse(duty.endsAt) - 1);
    const afterEnd = new Date(Date.parse(duty.endsAt) + 1);
    expect(getRuntimeDutyState(duty, beforeEnd).expired).toBe(false);
    expect(getRuntimeDutyState(duty, afterEnd)).toMatchObject({ expired: true, active: false, status: 'expired' });
    expect(publicDutiesForRegion(dataset, duty.coverageName, afterEnd).some((candidate) => candidate.id === duty.id)).toBe(false);
  });
});
