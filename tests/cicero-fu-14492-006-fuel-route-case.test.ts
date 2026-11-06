import { describe, expect, it } from 'vitest';

import { resolveSearchConsoleCompatTarget } from '../build-plugins/searchConsoleCompat';

describe('FU-2026-10-22-006 — fuel-station route case drift', () => {
  it('resolves case-drifted locale, section, city, and station marker together', () => {
    expect(resolveSearchConsoleCompatTarget(
      '/EN/FUEL-PRICES-SWITZERLAND/LUGANO/STATIONS/socar-via-colombera',
    )).toEqual({
      canonicalPath: '/en/gasoline-price-switzerland/lugano/today/',
      kind: 'legacy',
      locale: 'en',
    });
  });
});
