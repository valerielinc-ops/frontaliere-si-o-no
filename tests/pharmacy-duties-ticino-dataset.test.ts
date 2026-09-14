import { describe, expect, it } from 'vitest';
import dataset from '../data/pharmacy-duties-ticino.json';
import pharmacies from '../data/pharmacies-ticino-complete.json';
import { reclassifyPreservedDuties } from '../scripts/import-pharmacy-duties-ticino.mjs';
import { getRuntimeDutyState, publicDutiesForRegion } from '../services/pharmacies/duties';
import { validatePharmacyDuty, validatePharmacyDutyList, validatePharmacyDutiesDataset, type PharmacyDutiesDataset } from '../services/pharmacies/types';

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

  it('requires ISO instants and keeps verified/expired status aligned with the interval', () => {
    const now = new Date('2026-09-14T12:00:00.000Z');
    const sample = typedDataset.duties.find((duty) => duty.status === 'verified');
    expect(sample).toBeDefined();
    expect(validatePharmacyDuty(0, { ...sample, startsAt: '2026-09-14' }, now)).toContain('duty[0]: invalid startsAt');
    expect(validatePharmacyDuty(0, { ...sample, endsAt: '2026-09-13T12:00:00.000Z' }, now)).toContain('duty[0]: verified duty must not be expired');
    expect(validatePharmacyDuty(0, { ...sample, status: 'expired' }, now)).toContain('duty[0]: expired duty must have ended');
  });

  it('reclassifies only ended preserved verified intervals before validation', () => {
    const now = new Date('2026-09-14T12:00:00.000Z');
    const sample = typedDataset.duties.find((duty) => duty.status === 'verified');
    expect(sample).toBeDefined();
    const preserved = [
      { ...sample, id: 'preserved-ended', endsAt: '2026-09-14T11:59:59.000Z', status: 'verified' as const },
      { ...sample, id: 'preserved-active', endsAt: '2026-09-14T12:00:01.000Z', status: 'verified' as const },
      { ...sample, id: 'preserved-pending', endsAt: '2026-09-14T11:00:00.000Z', status: 'pending_review' as const },
    ];

    const reclassified = reclassifyPreservedDuties(preserved, now);
    expect(reclassified.map((duty) => duty.status)).toEqual(['expired', 'verified', 'pending_review']);
    expect(preserved[0].status).toBe('verified');
    expect(validatePharmacyDutyList(reclassified, now)).not.toContain(expect.stringContaining('verified duty must not be expired'));
  });

  it('requires overlapping same-area intervals to be explicitly conflicting', () => {
    const sample = typedDataset.duties[0];
    const left = { ...sample, id: 'overlap-left', startsAt: '2026-09-08T06:00:00.000Z', endsAt: '2026-09-08T18:00:00.000Z', status: 'verified' as const };
    const nested = { ...sample, id: 'overlap-nested', startsAt: '2026-09-08T10:00:00.000Z', endsAt: '2026-09-08T11:00:00.000Z', status: 'verified' as const };
    const errors = validatePharmacyDutyList([left, nested], new Date('2026-09-14T12:00:00.000Z'));

    expect(errors.some((error) => error.includes('overlapping coverage interval'))).toBe(true);
    expect(validatePharmacyDutyList([{ ...left, status: 'conflicting' as const }, { ...nested, status: 'conflicting' as const }], new Date('2026-09-14T12:00:00.000Z'))).not.toContain(expect.stringContaining('overlapping coverage interval'));
  });
});
