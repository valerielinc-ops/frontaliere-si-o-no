import { describe, expect, it } from 'vitest';
import { isAmbiguousSocialPublishResponse } from '../scripts/lib/social-publish-outcome.mjs';

describe('isAmbiguousSocialPublishResponse', () => {
  it.each([undefined, null, {}, { status: null }, { status: 408 }, { status: 500 }, { status: 503 }])(
    'holds reservations for an ambiguous response: %s',
    (response) => {
      expect(isAmbiguousSocialPublishResponse(response)).toBe(true);
    },
  );

  it.each([400, 401, 403, 429])('classifies HTTP %s as an explicit response', (status) => {
    expect(isAmbiguousSocialPublishResponse({ status })).toBe(false);
  });
});
