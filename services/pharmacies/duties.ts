import type { PharmacyDuty, PharmacyDutyStatus, PharmacyDutiesDataset } from './types';

export interface RuntimeDutyState {
  status: PharmacyDutyStatus;
  active: boolean;
  expired: boolean;
  startsAt: Date;
  endsAt: Date;
}

export function getRuntimeDutyState(duty: PharmacyDuty, now: Date = new Date()): RuntimeDutyState {
  const startsAt = new Date(duty.startsAt);
  const endsAt = new Date(duty.endsAt);
  const expired = !Number.isFinite(endsAt.getTime()) || endsAt.getTime() <= now.getTime();
  const active = duty.status === 'verified'
    && !expired
    && Number.isFinite(startsAt.getTime())
    && startsAt.getTime() <= now.getTime();
  return {
    status: expired && duty.status === 'verified' ? 'expired' : duty.status,
    active,
    expired,
    startsAt,
    endsAt,
  };
}

export function isDutyCurrentlyActive(duty: PharmacyDuty, now: Date = new Date()): boolean {
  return getRuntimeDutyState(duty, now).active;
}

export function publicDutiesForRegion(
  dataset: PharmacyDutiesDataset,
  coverageName: string,
  now: Date = new Date(),
): PharmacyDuty[] {
  return dataset.duties
    .filter((duty) => duty.coverageName === coverageName)
    .filter((duty) => duty.status === 'verified' && !getRuntimeDutyState(duty, now).expired)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

export function currentDutyForRegion(
  dataset: PharmacyDutiesDataset,
  coverageName: string,
  now: Date = new Date(),
): PharmacyDuty | undefined {
  return dataset.duties.find((duty) => duty.coverageName === coverageName && isDutyCurrentlyActive(duty, now));
}
