import { describe, expect, it } from 'vitest';
import { findUnsupportedConsultingClaims } from '../scripts/ci/check-consulting-provider-disclosure.mjs';

describe('consulting provider disclosure', () => {
  it('keeps every static, runtime, and SEO consulting surface free of unsupported provider claims', () => {
    expect(findUnsupportedConsultingClaims()).toEqual({ missing: [], violations: [] });
  });
});
