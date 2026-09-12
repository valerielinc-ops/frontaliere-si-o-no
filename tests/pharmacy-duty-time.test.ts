import { describe, expect, it } from 'vitest';

import { localDateTimeToIso } from '../services/pharmacies/time.mjs';

describe('pharmacy duty Zurich local time', () => {
  it('maps a non-existent spring-forward time to the next valid instant', () => {
    expect(localDateTimeToIso('29/03/2026', '02:30')).toBe('2026-03-29T01:30:00.000Z');
  });

  it('still rejects malformed calendar and clock values', () => {
    expect(() => localDateTimeToIso('31/02/2026', '08:00')).toThrow(/Invalid Zurich local datetime/);
    expect(() => localDateTimeToIso('29/03/2026', '24:00')).toThrow(/Invalid Zurich local datetime/);
  });
});
