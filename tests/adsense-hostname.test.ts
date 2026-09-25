import { describe, expect, it } from 'vitest';

import { isAdSenseProductionHost } from '@/components/shared/AdSenseBanner';

describe('isAdSenseProductionHost', () => {
  it('accepts both apex and www production hosts', () => {
    expect(isAdSenseProductionHost('frontaliereticino.ch')).toBe(true);
    expect(isAdSenseProductionHost('frontaliereticino.ch')).toBe(true);
  });

  it('rejects non-production hosts', () => {
    expect(isAdSenseProductionHost('localhost')).toBe(false);
    expect(isAdSenseProductionHost('staging.frontaliereticino.ch')).toBe(false);
  });
});
