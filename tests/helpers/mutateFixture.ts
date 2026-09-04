/**
 * Applies a literal (or regex) substitution to a test fixture and fails loudly
 * when it matches nothing.
 *
 * `String.prototype.replace()` returns the input unchanged when the needle is
 * absent, so a case that builds its input by patching a fixture — e.g. adding
 * the nested `<small>+N more&hellip;</small>` marker to a j2w location cell —
 * silently degrades into a parse of the PRISTINE fixture as soon as the
 * fixture is re-recorded with different indentation or markup. The assertions
 * that were meant to prove the marker is stripped then stay green without ever
 * seeing a marker: the guard becomes vacuous exactly when it should catch the
 * regression (#7265).
 */
export function mutateFixture(fixture: string, from: string | RegExp, to: string): string {
  const mutated = fixture.replace(from, to);
  if (mutated === fixture) {
    throw new Error(
      `mutateFixture: no-op substitution — the fixture no longer contains ${JSON.stringify(
        String(from),
      )}, so the case built on it would be vacuous. Re-align the needle with the fixture.`,
    );
  }
  return mutated;
}
