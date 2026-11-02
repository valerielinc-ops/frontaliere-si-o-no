import { describe, expect, it, vi } from 'vitest';
import {
  APPLICATION_CONCIERGE_RENEWAL_ENABLED_RC_KEY,
  APPLICATION_CONCIERGE_RENEWAL_ROLLOUT_PERCENT_RC_KEY,
  isApplicationConciergeRenewalAssigned,
  isApplicationConciergeRenewalEnabledFor,
} from '../functions/src/applicationConciergeRenewalRollout.js';

describe('application concierge renewal rollout', () => {
  it('fails closed when the flag or rollout percentage is missing or invalid', async () => {
    const read = vi.fn(async (_key: string) => '');
    await expect(isApplicationConciergeRenewalEnabledFor('candidate-42', read)).resolves.toBe(false);
    read.mockImplementation(async (key: string) => key === APPLICATION_CONCIERGE_RENEWAL_ENABLED_RC_KEY ? 'true' : '101');
    await expect(isApplicationConciergeRenewalEnabledFor('candidate-42', read)).resolves.toBe(false);
  });

  it('fails closed when Remote Config cannot be read', async () => {
    const read = vi.fn(async (_key: string) => { throw new Error('unavailable'); });
    await expect(isApplicationConciergeRenewalEnabledFor('candidate-42', read)).resolves.toBe(false);
  });

  it('keeps assignment stable per account and honors zero and full rollout', () => {
    const subject = 'candidate-42';
    expect(isApplicationConciergeRenewalAssigned(subject, { enabled: false, rolloutPercent: 100 })).toBe(false);
    expect(isApplicationConciergeRenewalAssigned(subject, { enabled: true, rolloutPercent: 0 })).toBe(false);
    expect(isApplicationConciergeRenewalAssigned(subject, { enabled: true, rolloutPercent: 100 })).toBe(true);
    const assignment = isApplicationConciergeRenewalAssigned(subject, { enabled: true, rolloutPercent: 50 });
    expect(Array.from({ length: 20 }, () => isApplicationConciergeRenewalAssigned(subject, { enabled: true, rolloutPercent: 50 })))
      .toEqual(Array(20).fill(assignment));
  });

  it('reads the global switch and rollout percentage from Remote Config', async () => {
    const read = vi.fn(async (key: string) => {
      if (key === APPLICATION_CONCIERGE_RENEWAL_ENABLED_RC_KEY) return 'true';
      if (key === APPLICATION_CONCIERGE_RENEWAL_ROLLOUT_PERCENT_RC_KEY) return '100';
      return '';
    });
    await expect(isApplicationConciergeRenewalEnabledFor('candidate-42', read)).resolves.toBe(true);
    expect(read).toHaveBeenCalledWith(APPLICATION_CONCIERGE_RENEWAL_ENABLED_RC_KEY);
    expect(read).toHaveBeenCalledWith(APPLICATION_CONCIERGE_RENEWAL_ROLLOUT_PERCENT_RC_KEY);
  });
});
