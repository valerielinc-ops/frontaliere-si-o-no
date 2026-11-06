/**
 * Drift guard for the canton URL slug table.
 *
 * data/canton-url-slugs.json is canonical (services/router.ts reads it).
 * functions/src/lib/cantonUrlSlugs.json is a verbatim duplicate — Cloud
 * Functions have no bundler and cannot import outside functions/ at deploy
 * time (firebase.json source:"functions") — see the _syncNote in that file
 * and functions/src/lib/jobBoardUrlCanton.js. This test locks the two
 * copies together so they can never drift silently.
 */
import { describe, it, expect } from 'vitest';

import canonical from '../data/canton-url-slugs.json';
import duplicate from '../functions/src/lib/cantonUrlSlugs.json';

describe('canton-url-slugs.json parity (functions/ duplicate === canonical)', () => {
  it('cantons table matches', () => {
    expect(duplicate.cantons).toEqual(canonical.cantons);
  });

  it('cantonGroups table matches', () => {
    expect(duplicate.cantonGroups).toEqual(canonical.cantonGroups);
  });

  it('aggregate slugs match', () => {
    expect(duplicate.aggregate).toEqual(canonical.aggregate);
  });
});
