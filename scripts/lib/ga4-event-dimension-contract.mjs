/**
 * GA4 EVENT-scoped custom dimensions are addressed by parameterName in Data
 * API queries, but their Admin API scope and displayName are immutable parts
 * of the definition contract.
 */
export function findGa4CustomDimension(customDimensions, parameterName) {
  if (!Array.isArray(customDimensions)) return null;
  return customDimensions.find((dimension) => dimension?.parameterName === parameterName) || null;
}

export function ga4EventDimensionContractMismatch(expected, actual) {
  if (!actual) {
    return `GA4 custom dimension ${expected.parameterName} was not listed after a 409 conflict; its contract cannot be verified`;
  }
  const mismatches = [];
  if (actual.scope !== 'EVENT') mismatches.push('scope (expected EVENT)');
  if (actual.displayName !== expected.displayName) {
    mismatches.push(`displayName (expected "${expected.displayName}")`);
  }
  return mismatches.length
    ? `GA4 custom dimension ${expected.parameterName} has mismatched ${mismatches.join(' and ')}`
    : null;
}

export function ga4EventDimensionScopeMismatch(parameterName, actual) {
  if (!actual) return `shared GA4 custom dimension ${parameterName} is missing from the property`;
  return actual.scope === 'EVENT'
    ? null
    : `shared GA4 custom dimension ${parameterName} has scope ${actual.scope || '(missing)'}, expected EVENT`;
}

export function validateGa4EventDimensionPlan(expectedDimensions, existingDimensions, existingMetrics = []) {
  const failures = [];
  for (const expected of expectedDimensions) {
    const existing = findGa4CustomDimension(existingDimensions, expected.parameterName);
    if (existing) {
      const mismatch = ga4EventDimensionContractMismatch(expected, existing);
      if (mismatch) failures.push(mismatch);
      continue;
    }
    if (existingMetrics.some((metric) => metric?.parameterName === expected.parameterName)) {
      failures.push(`GA4 custom dimension ${expected.parameterName} conflicts with an existing custom metric`);
    }
  }
  return failures;
}
