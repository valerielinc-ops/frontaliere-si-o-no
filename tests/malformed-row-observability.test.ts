import { describe, expect, it } from 'vitest';

import {
  MALFORMED_ROW_ERROR_RATIO,
  classifyMalformedRowDrift,
} from '../scripts/lib/malformed-row-observability.mjs';

describe('malformed-row observability', () => {
  it.each([
    { parsed: 0, skipped: 0, severity: 'none', ratio: 0 },
    { parsed: 9, skipped: 1, severity: 'warning', ratio: 0.1 },
    { parsed: 2, skipped: 1, severity: 'warning', ratio: 1 / 3 },
    { parsed: 1, skipped: 1, severity: 'error', ratio: 0.5 },
    { parsed: 1, skipped: 9, severity: 'error', ratio: 0.9 },
    { parsed: 0, skipped: 1, severity: 'error', ratio: 1 },
  ])('classifies $parsed parsed / $skipped skipped as $severity', ({
    parsed,
    skipped,
    severity,
    ratio,
  }) => {
    const result = classifyMalformedRowDrift(parsed, skipped);
    expect(result).toEqual({
      parsed,
      skipped,
      total: parsed + skipped,
      ratio,
      severity,
    });
  });

  it('documents the shared partial-drift error threshold', () => {
    expect(MALFORMED_ROW_ERROR_RATIO).toBe(0.5);
  });

  it('supports a caller-specific stricter threshold without hiding drops', () => {
    expect(classifyMalformedRowDrift(3, 1, { errorRatio: 0.25 }).severity).toBe('error');
  });

  it.each([
    [-1, 0, undefined],
    [1.5, 0, undefined],
    [0, -1, undefined],
    [0, 1.5, undefined],
    [0, 0, { errorRatio: 0 }],
    [0, 0, { errorRatio: 1.1 }],
  ])('rejects invalid counters or thresholds', (parsed, skipped, options) => {
    expect(() => classifyMalformedRowDrift(parsed, skipped, options)).toThrow(TypeError);
  });
});
