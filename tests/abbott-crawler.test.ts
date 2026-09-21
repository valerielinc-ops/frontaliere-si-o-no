import { describe, expect, it } from 'vitest';
import {
  ABBOTT_COMPANY_NAME,
  ABBOTT_KEY,
  resolveAbbottLocation,
} from '../scripts/lib/abbott-job-parser.mjs';

describe('Abbott crawler location resolution', () => {
  it('uses the structured requisition locality over a Workday listing label', () => {
    expect(resolveAbbottLocation(
      'Switzerland - Basel',
      { descriptor: 'Switzerland > Allschwil : H-127' },
    )).toBe('Allschwil');
    expect(resolveAbbottLocation(
      'Switzerland - Remote',
      { descriptor: 'Switzerland > Baar : Neuhofstrasse 23' },
    )).toBe('Baar');
  });

  it('falls back to the listing locality when the requisition field is absent', () => {
    expect(resolveAbbottLocation('Switzerland - Zurich')).toBe('Zurich');
  });

  it('keeps the parser identity stable', () => {
    expect(ABBOTT_KEY).toBe('abbott');
    expect(ABBOTT_COMPANY_NAME).toBe('Abbott');
  });
});
