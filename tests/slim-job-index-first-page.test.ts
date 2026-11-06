import { describe, it, expect } from 'vitest';
import {
  FIRST_PAGE_SLICE_SIZE,
  firstPageIndexFileName,
} from '@/build-plugins/shared/slimJobIndex';

describe('first-page slim index (#2580)', () => {
  it('slices well above the listing page size so page 1 + scroll headroom paints from the tiny asset', () => {
    // The listing renders 10 cards/page; the first-page asset must comfortably
    // cover page 1 plus a little scroll so the SPA never shows an empty list
    // before the full index lands.
    expect(FIRST_PAGE_SLICE_SIZE).toBeGreaterThanOrEqual(20);
  });

  it('derives the per-locale asset name by construction (emitter & fetch path cannot drift)', () => {
    expect(firstPageIndexFileName('it')).toBe('jobs-it-index-first.json');
    expect(firstPageIndexFileName('en')).toBe('jobs-en-index-first.json');
    expect(firstPageIndexFileName('de')).toBe('jobs-de-index-first.json');
    expect(firstPageIndexFileName('fr')).toBe('jobs-fr-index-first.json');
  });
});
