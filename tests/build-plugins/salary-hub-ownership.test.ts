import { describe, expect, it } from 'vitest';
import {
  SALARY_HUB_SCENARIO_INDEX_OWNERSHIP_PATTERN,
  SALARY_HUB_SCENARIO_OWNERSHIP_PATTERN,
} from '../../build-plugins/salaryHubPlugin';

describe('salaryHubPlugin shared path ownership patterns', () => {
  it('covers generated salary scenario variants, not only the base salary slug', () => {
    expect(
      SALARY_HUB_SCENARIO_OWNERSHIP_PATTERN.test(
        '/tmp/dist/fr/calculer-salaire/salaire-net-95000-chf-marie-3-enfants-nouveau-frontalier-plus-20km/index.html',
      ),
    ).toBe(true);
    expect(
      SALARY_HUB_SCENARIO_OWNERSHIP_PATTERN.test(
        '/tmp/dist/en/calculate-salary/net-salary-60000-chf-married-2-children-new-crossborder-within-20km.html',
      ),
    ).toBe(true);
    expect(
      SALARY_HUB_SCENARIO_OWNERSHIP_PATTERN.test('/tmp/dist/calcola-stipendio/confronta-stipendi/index.html'),
    ).toBe(false);
  });

  it('covers the browseable scenario indexes in every locale', () => {
    expect(SALARY_HUB_SCENARIO_INDEX_OWNERSHIP_PATTERN.test('/tmp/dist/calcola-stipendio/scenari/index.html')).toBe(true);
    expect(SALARY_HUB_SCENARIO_INDEX_OWNERSHIP_PATTERN.test('/tmp/dist/en/calculate-salary/scenarios.html')).toBe(true);
    expect(SALARY_HUB_SCENARIO_INDEX_OWNERSHIP_PATTERN.test('/tmp/dist/de/gehalt-berechnen/szenarien/index.html')).toBe(true);
    expect(SALARY_HUB_SCENARIO_INDEX_OWNERSHIP_PATTERN.test('/tmp/dist/fr/calculer-salaire/scenarios/index.html')).toBe(true);
  });
});
