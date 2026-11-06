import { describe, expect, it } from 'vitest';

import { assertCantonHubLocaleSlug } from '../../packages/articles/engine/shared/cantonSectionCopy.mjs';

const ERROR = 'canton-ti: slug hub mancante o vuoto per carburanti/en';

describe('canton hub locale slug validation', () => {
  it('returns an explicitly localized own-property slug', () => {
    expect(assertCantonHubLocaleSlug('canton-ti', 'carburanti', 'en', { en: 'fuel' })).toBe('fuel');
  });

  it('rejects a missing locale slug', () => {
    expect(() => assertCantonHubLocaleSlug('canton-ti', 'carburanti', 'en', { it: 'carburanti' })).toThrow(ERROR);
  });

  it('rejects an inherited locale slug', () => {
    const inheritedSlugs = Object.create({ en: 'fuel' }) as Record<string, string>;
    inheritedSlugs.it = 'carburanti';

    expect(() => assertCantonHubLocaleSlug('canton-ti', 'carburanti', 'en', inheritedSlugs)).toThrow(ERROR);
  });

  it('rejects a blank locale slug', () => {
    expect(() => assertCantonHubLocaleSlug('canton-ti', 'carburanti', 'en', { en: '  ' })).toThrow(ERROR);
  });
});
