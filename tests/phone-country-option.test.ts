import { describe, expect, it } from 'vitest';
import { createPhoneCountryOptionMatcher, phoneCountryOptionMatches, phoneCountryCode, phoneDialCode, phoneCountryLabel } from '../functions/src/lib/phoneNormalization.js';
const phone = '+393331234567';
describe('closed phone-country options', () => {
  it.each(['IT', 'Italia', 'Italy (+39)', 'Italien +39', '+39', '0039'])('accepts the whole native %s caption for the actual phone', label => {
    expect(phoneCountryOptionMatches({ label, value: 'opaque_42' }, phone)).toBe(true);
  });
  it.each([
    { label: 'Italy (+39) — B permit', value: 'IT' }, { label: '+39 I hold a degree', value: '39' },
    { label: 'Switzerland (+41)', value: 'IT' }, { value: 'IT' }, { label: '', value: '39' },
  ])('does not turn country-like option data into authority for %j', option => {
    expect(phoneCountryOptionMatches(option, phone)).toBe(false);
  });
  it('executes the same serializable factory in the generated-browser boundary', () => {
    const recreate = (0, eval)(`(${createPhoneCountryOptionMatcher.toString()})`);
    const browserMatch = recreate({ phoneCountryCode, phoneDialCode, phoneCountryLabel });
    expect(browserMatch({ label: 'Italy (+39)', value: 'opaque_42' }, phone)).toBe(true);
    expect(browserMatch({ label: 'Italy (+39) — B permit', value: 'IT' }, phone)).toBe(false);
    expect(browserMatch({ value: 'IT' }, phone)).toBe(false);
    expect(browserMatch({ label: 'Italia' }, '3331234567')).toBe(false);
  });
});
