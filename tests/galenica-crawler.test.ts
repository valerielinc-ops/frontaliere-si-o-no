/**
 * Galenica crawler — Swiss-item filter tests.
 *
 * Sibling fix of the UBS resolveSwissLocation guard (see
 * tests/ubs-crawler.test.ts) — issue #3055 item 3 (item 2 is the UBS
 * counterpart). Both `inferAnyCanton(city)` branches used to bypass their
 * respective region/state validity check, so a foreign job whose city name
 * happens to alias a Swiss canton could incorrectly survive as Swiss.
 *
 * Importing update-galenica-jobs.mjs is safe: its `main()` call is guarded by
 * `process.argv[1] === fileURLToPath(import.meta.url)`, so importing it for
 * `isSwissGalenicaItem` does not trigger a live crawl.
 */
import { describe, it, expect } from 'vitest';

import { isSwissGalenicaItem } from '../scripts/update-galenica-jobs.mjs';
import { SWISS_CANTONS } from '../scripts/lib/crawler-location-config.mjs';

describe('isSwissGalenicaItem (issue #3055 item 3)', () => {
  it('rejects a populated non-Swiss state even when the city aliases a Swiss canton', () => {
    // "Lugano" resolves to TI via the shared inferAnyCanton fuzzy city-name
    // match. "BY" (Bavaria) is a populated, clearly non-Swiss state code.
    // Pre-fix this item would have survived the filter purely on the city
    // alias, ignoring the foreign state. Post-fix it must be rejected.
    const item = { contact: { state: 'BY', city: 'Lugano' } };
    expect(SWISS_CANTONS.BY).toBeUndefined(); // sanity: not a Swiss canton code
    expect(isSwissGalenicaItem(item)).toBe(false);
  });

  it('keeps an item with a recognized Swiss canton state', () => {
    const item = { contact: { state: 'TI', city: 'Bellinzona' } };
    expect(isSwissGalenicaItem(item)).toBe(true);
  });

  it('keeps an item with a blank state and a Swiss city alias (no regression)', () => {
    const item = { contact: { state: '', city: 'Lugano' } };
    expect(isSwissGalenicaItem(item)).toBe(true);
  });

  it('rejects an item with a blank state and a non-Swiss city', () => {
    const item = { contact: { state: '', city: 'Berlin' } };
    expect(isSwissGalenicaItem(item)).toBe(false);
  });
});
