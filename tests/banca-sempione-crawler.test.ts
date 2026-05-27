import { describe, expect, it } from 'vitest';
import {
  inferLocation,
  shouldKeepBancaSempioneJob,
} from '../scripts/update-banca-sempione-jobs.mjs';

describe('banca sempione crawler location guards', () => {
  it('classifies explicit Middle East roles as Dubai even if the body mentions Lugano headquarters', () => {
    const inferred = inferLocation(
      'Relationship Manager – Banca del Sempione (Middle East)',
      'Banca del Sempione is headquartered in Lugano and is looking for a profile focused on Dubai and the DIFC market.',
    );

    expect(inferred).toEqual({ location: 'Dubai', canton: '', country: 'AE' });
    expect(shouldKeepBancaSempioneJob(inferred)).toBe(false);
  });

  it('keeps Banca Sempione roles in any target Swiss canton (Lugano, Zurich, …)', () => {
    const zurich = inferLocation(
      'Private Banking Assistant',
      'The role is based in Zurich and supports the local office.',
    );
    const lugano = inferLocation(
      'Global Wealth Management – Consulente alla Clientela / Private Banker',
      'Role based in Lugano with client coverage in Ticino.',
    );

    // Banca Sempione has a Zurich office; cathedral CH-wide scope keeps it.
    expect(zurich).toEqual({ location: 'Zurich', canton: 'ZH' });
    expect(shouldKeepBancaSempioneJob(zurich)).toBe(true);
    expect(lugano).toEqual({ location: 'Lugano', canton: 'TI' });
    expect(shouldKeepBancaSempioneJob(lugano)).toBe(true);
  });
});
