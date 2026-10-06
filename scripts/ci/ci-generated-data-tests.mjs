/**
 * Tests that reconstruct generated repositories/workflows instead of testing
 * a stable, checked-in input.
 *
 * They remain available for an explicit, targeted run, but they do not belong
 * to the blocking PR gate: their cost grows with generated artifacts and they
 * are not a deterministic signal about the changed application code.
 */
export const CI_GENERATED_DATA_TESTS = Object.freeze([
  // Rebuilds the complete crawler workflow/cross-repo artifact set. The
  // related-test artifact measured ~11m40s for this file.
  'tests/generate-crawler-group-workflows.test.ts',
  // Creates several bare/cloned repositories and publishes generated slices.
  // The related-test artifact measured ~70s for this file.
  'tests/translation-state-drainer-v2.test.ts',
]);

export function shouldSkipCiGeneratedDataTests(env = process.env) {
  return env.VITEST_SKIP_GENERATED_DATA_TESTS === 'true'
    // tests.yml already carries VITEST_SKIP_LIVE_DATA for the deterministic
    // PR gate, and the related runner composes this policy with that flag.
    || env.VITEST_SKIP_LIVE_DATA === 'true';
}

export function listCiGeneratedDataTests() {
  return [...CI_GENERATED_DATA_TESTS];
}
