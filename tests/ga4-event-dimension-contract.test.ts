import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  findGa4CustomDimension,
  ga4EventDimensionContractMismatch,
  ga4EventDimensionScopeMismatch,
  validateGa4EventDimensionPlan,
} from '../scripts/lib/ga4-event-dimension-contract.mjs';

describe('GA4 EVENT custom-dimension contract', () => {
  const expected = { parameterName: 'emission_id', displayName: 'Analytics Emission ID' };

  it('finds an existing definition by parameterName and requires its exact EVENT contract', () => {
    const existing = [{ parameterName: 'emission_id', displayName: 'Analytics Emission ID', scope: 'EVENT' }];

    expect(findGa4CustomDimension(existing, 'emission_id')).toBe(existing[0]);
    expect(ga4EventDimensionContractMismatch(expected, existing[0])).toBeNull();
    expect(ga4EventDimensionContractMismatch(expected, { ...existing[0], scope: 'USER' })).toContain('scope');
    expect(ga4EventDimensionContractMismatch(expected, { ...existing[0], displayName: 'Emission ID' })).toContain('displayName');
    expect(findGa4CustomDimension(undefined, 'emission_id')).toBeNull();
  });

  it('fails closed when a 409 winner is absent or has a different scope', () => {
    expect(ga4EventDimensionContractMismatch(expected, null)).toContain('after a 409 conflict');
    expect(ga4EventDimensionContractMismatch(expected, { ...expected, scope: 'USER' })).toContain('mismatched scope');
  });

  it('preflights all existing EVENT dimensions before any create and catches type collisions', () => {
    const failures = validateGa4EventDimensionPlan(
      [expected, { parameterName: 'employer_key', displayName: 'Employer Key' }],
      [{ ...expected, scope: 'USER' }],
      [{ parameterName: 'employer_key' }],
    );

    expect(failures).toEqual([
      'GA4 custom dimension emission_id has mismatched scope (expected EVENT)',
      'GA4 custom dimension employer_key conflicts with an existing custom metric',
    ]);
  });

  it('requires shared ad-page dimensions to be EVENT-scoped and wires preflight before writes', () => {
    expect(ga4EventDimensionScopeMismatch('page_template', null)).toContain('missing from the property');
    expect(ga4EventDimensionScopeMismatch('page_template', { scope: 'USER' })).toContain('expected EVENT');
    expect(ga4EventDimensionScopeMismatch('page_template', { scope: 'EVENT' })).toBeNull();

    const source = readFileSync(resolve(import.meta.dirname, '../scripts/setup-ga4-ad-page-diag-definitions.mjs'), 'utf8');
    expect(source).toContain('validateGa4EventDimensionPlan(');
    expect(source).toContain('ga4EventDimensionContractMismatch(definition, actual)');
    expect(source.indexOf('validateGa4EventDimensionPlan(')).toBeLessThan(
      source.indexOf('await create(headers, kind, definition)'),
    );
  });
});
