import { describe, expect, it } from 'vitest';

import {
  sanitizeTrackedDiagnosticValue,
  sanitizeUrlLikeText,
} from '../../../scripts/lib/sanitizeTrackedDiagnostics.mjs';

describe('sanitizeTrackedDiagnostics', () => {
  it('redacts secret and personal query values in diagnostic URLs', () => {
    const value = sanitizeUrlLikeText(
      'https://frontaliereticino.ch/en/?action=unsubscribe&email=test@example.com&token=abcdef1234567890abcdef1234567890&ne=test@example.com&ac=65e625755aaca0c620dcdeb85a9e1426b4a38ea99d120f35e4cbf1cfbec15ea5&utm_medium=newsletter#google_vignette'
    );

    expect(value).toContain('action=unsubscribe');
    expect(value).toContain('utm_medium=newsletter');
    expect(value).toContain('email=x');
    expect(value).toContain('token=x');
    expect(value).toContain('ne=x');
    expect(value).toContain('ac=x');
    expect(value).not.toContain('test@example.com');
    expect(value).not.toContain('abcdef1234567890abcdef1234567890');
  });

  it('recursively sanitizes nested PostHog result shapes', () => {
    const value = sanitizeTrackedDiagnosticValue({
      results: [
        [
          'Failed to fetch',
          'https://frontaliereticino.ch/?action=confirm_newsletter&email=user@example.com&token=feeec51803ecc4354df2a4efb46bb3c39d85a88b2c00f6c9d8f49344d87b47dc',
          2,
        ],
      ],
    });

    expect(value.results[0][1]).toContain('email=x');
    expect(value.results[0][1]).toContain('token=x');
    expect(value.results[0][1]).not.toContain('user@example.com');
    expect(value.results[0][2]).toBe(2);
  });
});
