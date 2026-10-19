/** Exact source-backed paths from the current event producer, not guessed towns.
 * Published only after its collector flush; cleared before every build, including
 * skipped/empty watch rebuilds. Late compat consumers await that producer. */
const emittedPaths = new Set<string>();

export function replaceEmittedEventArchivePaths(paths: Iterable<string>): void {
  emittedPaths.clear();
  for (const path of paths) emittedPaths.add(path);
}

export function isEmittedEventArchivePath(path: string): boolean {
  return emittedPaths.has(path.endsWith('/') ? path : `${path}/`);
}
