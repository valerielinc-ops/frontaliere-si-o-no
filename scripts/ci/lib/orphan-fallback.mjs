/**
 * shouldSkipFullSuiteFallback — decides whether the "no static related edge
 * found" case may skip the conservative full-suite fallback in
 * run-related-tests.mjs.
 *
 * The fallback exists because a changed file with no detected related test
 * might still be reachable by test coverage through an import the static
 * graph missed (a dynamic import, a runtime path string) — running
 * everything is the safe default when that possibility exists.
 *
 * But when every changed file has ZERO importers anywhere in the repository
 * — not just no test importer, no importer at all, at any distance — that
 * possibility doesn't exist: nothing in the codebase references the file, so
 * no test, direct or transitive, could ever exercise it through an import.
 * This is exactly the shape of a standalone CLI script (`node scripts/x.mjs`,
 * never `import`-ed). For that case the full-suite fallback protects
 * nothing specific to the change and only pays its cost, so it is safe to
 * skip — same as if the file were not runnable-test-adjacent at all.
 *
 * A changed file that IS imported by something (even a file with no test
 * coverage of its own) keeps the full-suite fallback: that importer's own
 * blind spots are exactly what the fallback guards against.
 */
export function shouldSkipFullSuiteFallback(candidates, reverse) {
  if (candidates.length === 0) return false;
  return candidates.every((c) => !(reverse.get(c) || []).length);
}
