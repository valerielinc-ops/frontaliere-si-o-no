import { describe, it, expect } from 'vitest';
import { claimEnvKey, RC_TO_ENV } from '../scripts/load-rc-env.mjs';

describe('load-rc-env target precedence', () => {
  it('keeps the specific LSA token ahead of the legacy fallback', () => {
    const queuedEnvKeys = new Set<string>();
    const emittedValues: string[] = [];

    for (const value of ['lsa-token-from-specific-plan', 'legacy-fallback-token']) {
      if (claimEnvKey(queuedEnvKeys, 'OPENTRANSPORTDATA_API_KEY')) {
        emittedValues.push(value);
      }
    }

    expect(emittedValues).toEqual(['lsa-token-from-specific-plan']);
  });

  it('maps the optional Tankerkönig key without exposing it to the client', () => {
    expect(RC_TO_ENV.TANKERKOENIG_API_KEY).toEqual(['TANKERKOENIG_API_KEY']);
  });
});
