import { describe, expect, it } from 'vitest';
import { addressContextContract, hasAddressContextOwnership } from '../functions/src/lib/addressContextContract.js';
describe('address ownership proof is distinct from its canonical representation', () => {
  it.each([{ section: '', owners: [], unknown: false }, { section: '  ', owners: ['\t'], unknown: false }])('preserves an empty representation without granting proof: %j', addressContext => {
    expect(addressContextContract({ addressContext })).toEqual(addressContext);
    expect(hasAddressContextOwnership({ addressContext })).toBe(false);
  });
  it.each([{ section: 'Employer address', owners: [], unknown: false }, { section: '', owners: ['Candidate contact'], unknown: false }])('recognizes a named scope without inferring its purpose: %j', addressContext => {
    expect(hasAddressContextOwnership({ addressContext })).toBe(true);
    expect(addressContextContract({ addressContext })).toEqual(addressContext);
  });
  it('keeps unknown, malformed and missing distinct and never treats them as proof', () => {
    expect(addressContextContract({})).toBeUndefined();
    expect(hasAddressContextOwnership({})).toBe(false);
    expect(hasAddressContextOwnership({ addressContext: { section: 'Candidate', owners: [], unknown: true } })).toBe(false);
    expect(hasAddressContextOwnership({ addressContext: { section: 'Candidate', owners: [], unknown: 'false' } })).toBe(false);
  });
});
