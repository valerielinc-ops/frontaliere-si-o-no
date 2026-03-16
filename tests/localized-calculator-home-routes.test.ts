import { describe, expect, it } from 'vitest';

import { parsePath } from '@/services/router';

describe('localized calculator home routes', () => {
  it('parses localized calculator home slugs as the calculator route in every language', () => {
    const cases = [
      { path: '/calcola-stipendio', locale: 'it' },
      { path: '/en/calculate-salary', locale: 'en' },
      { path: '/de/gehalt-berechnen', locale: 'de' },
      { path: '/fr/calculer-salaire', locale: 'fr' },
    ] as const;

    for (const testCase of cases) {
      const parsed = parsePath(testCase.path);
      expect(parsed.locale).toBe(testCase.locale);
      expect(parsed.route.activeTab).toBe('calculator');
      expect(parsed.route.calcolatoreSubTab).toBe('calculator');
    }
  });
});
