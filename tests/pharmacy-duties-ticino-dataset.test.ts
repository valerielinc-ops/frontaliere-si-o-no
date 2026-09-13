import { describe, expect, it } from 'vitest';
import dataset from '../data/pharmacy-duties-ticino.json';
import pharmacies from '../data/pharmacies-ticino-complete.json';
import { getRuntimeDutyState, publicDutiesForRegion } from '../services/pharmacies/duties';
import { validatePharmacyDutiesDataset, type PharmacyDutiesDataset } from '../services/pharmacies/types';

const typedDataset = dataset as unknown as PharmacyDutiesDataset;

describe('Ticino duty dataset', () => {
  it('matches the duty schema and only references known pharmacies', () => {
    expect(validatePharmacyDutiesDataset(typedDataset)).toEqual([]);
    const ids = new Set(pharmacies.pharmacies.map((pharmacy) => pharmacy.id));
    expect(typedDataset.duties.every((duty) => ids.has(duty.pharmacyId))).toBe(true);
    expect(new Set(typedDataset.duties.map((duty) => duty.coverageName))).toEqual(new Set(['Mendrisiotto', 'Luganese', 'Bellinzonese', 'Biasca e Valli']));
  });

  it('does not expose expired intervals as current after the page remains open', () => {
    const duty = typedDataset.duties[0];
    const beforeEnd = new Date(Date.parse(duty.endsAt) - 1);
    const afterEnd = new Date(Date.parse(duty.endsAt) + 1);
    expect(getRuntimeDutyState(duty, beforeEnd).expired).toBe(false);
    expect(getRuntimeDutyState(duty, afterEnd)).toMatchObject({ expired: true, active: false, status: 'expired' });
    expect(publicDutiesForRegion(typedDataset, duty.coverageName, afterEnd).some((candidate) => candidate.id === duty.id)).toBe(false);
  });
});
