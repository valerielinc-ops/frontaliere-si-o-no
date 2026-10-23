import { describe, expect, it } from 'vitest';
import {
  isUndeterminedMarker,
  parseResultRows,
} from '../scripts/ci/classify-validate-dist-failures.mjs';

describe('validate-dist result-row contract (#13377 FU-004)', () => {
  it('keeps successful rows out of the failed-gate list and preserves order', () => {
    expect(parseResultRows([
      'audit:seo 12.4 rc=0',
      'audit:hreflang 8.1 rc=2',
      'audit:all 4.0 rc=1',
    ].join('\n'))).toEqual(['audit:hreflang', 'audit:all']);
  });

  it('fails closed on an unnamed or non-numeric result row', () => {
    expect(parseResultRows('audit:seo 12.4')).toBeNull();
    expect(parseResultRows('audit:seo 12.4 rc=error')).toBeNull();
    expect(isUndeterminedMarker('__UNKNOWN__:postbuild')).toBe(true);
    expect(isUndeterminedMarker('audit:all')).toBe(true);
    expect(isUndeterminedMarker('audit:hreflang')).toBe(false);
  });
});
