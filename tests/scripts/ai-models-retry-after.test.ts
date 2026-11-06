import { describe, expect, it } from 'vitest';

import { parseRetryAfter, parseStrictRetryAfterValue } from '../../scripts/lib/ai-models.mjs';

const NOW_MS = Date.parse('Sun, 25 Oct 2026 08:00:00 GMT');

function response(value: unknown) {
  return { headers: { get: () => value } };
}

describe('ai-models Retry-After contract', () => {
  it('accepts bounded delta-seconds and canonical IMF-fixdate values', () => {
    expect(parseRetryAfter(response('10'), NOW_MS)).toBe(10_000);
    expect(parseRetryAfter(response('86400'), NOW_MS)).toBe(120_000);
    expect(parseRetryAfter(response('Sun, 25 Oct 2026 08:00:01 GMT'), NOW_MS)).toBe(1_000);
    expect(parseRetryAfter(response('Sun, 25 Oct 2026 07:59:59 GMT'), NOW_MS)).toBe(0);
  });

  it('rejects locale dates, invalid weekdays, unsafe numbers and non-string input', () => {
    expect(parseStrictRetryAfterValue('10/25/2026', NOW_MS)).toBe(0);
    expect(parseStrictRetryAfterValue('Mon, 25 Oct 2026 08:00:30 GMT', NOW_MS)).toBe(0);
    expect(parseStrictRetryAfterValue('9007199254740992', NOW_MS)).toBe(0);
    expect(parseStrictRetryAfterValue('9'.repeat(100), NOW_MS)).toBe(0);
    expect(parseStrictRetryAfterValue(10, NOW_MS)).toBe(0);
  });

  it('fails closed when a response header reader throws', () => {
    expect(parseRetryAfter({ headers: { get: () => { throw new Error('broken headers'); } } }, NOW_MS)).toBe(0);
  });
});
