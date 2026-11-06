import { describe, expect, it } from 'vitest';
import { minimumDataRetentionOption } from '../functions/src/lib/applicationConsent.js';

describe('minimum application-data retention option', () => {
  it('does not treat a negated first-person refusal as an active refusal', () => {
    const options = [
      'The candidate did not refuse the application; retain data for 12 months',
      'Retain data for 24 months',
    ];

    expect(minimumDataRetentionOption(options, 'How long should we retain your data?'))
      .toBe(options[0]);
  });

  it('still excludes an explicit first-person refusal', () => {
    const options = [
      'No, I refuse the application; retain data for 12 months',
      'Retain data for 24 months',
    ];

    expect(minimumDataRetentionOption(options, 'How long should we retain your data?'))
      .toBe(options[1]);
  });
});
