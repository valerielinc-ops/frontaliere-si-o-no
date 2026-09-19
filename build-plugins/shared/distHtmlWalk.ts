/**
 * Enumerate every `.html` file under a dist tree, skipping the top-of-tree
 * static-asset directories.
 *
 * Extracted from postWalkCoordinatorPlugin (issue #5130) so the enumeration can
 * be unit-tested against its reference implementation without importing the
 * coordinator's whole plugin graph (data/, services/, packages/articles/…).
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Walk every `.html` file under `dir`, skipping static-asset directories.
 *
 * Reverted from the async BFS variant (PR #802) back to a sync recursive walk.
 * Run 26608004451 [post-walk-profile]:
 *   walk-dist  PR #802 → 85.7 s   (vs 65.3 s sync baseline, +31%)
 * The 8-way `fs.promises.readdir` BFS contended with the post-walk worker pool
 * (each worker also issues `fs.promises.readFile` through libuv's default
 * 4-thread pool) and ended up paying Promise scheduling overhead + thread-pool
 * serialization that the C-runtime sync recursion avoided. Re-investigate when
 * the worker pool moves to io_uring native ops or `UV_THREADPOOL_SIZE` is
 * bumped repo-wide.
 *
 * Perf (2026-08-05, issue #5130): this used to be a `function*` generator
 * consumed with `yield*` delegation, and built each path with `path.join`. On
 * the `it` shard of run 31036546298 the tree is 1,308,502 HTML files and
 * `walk-dist` measured **202.3 s** of the coordinator's 344.6 s wall — a single
 * thread, before any worker is dispatched. Two costs, both pure overhead:
 *  - `yield*` re-enters every generator frame on the delegation chain for EVERY
 *    file, so a file at depth d costs d generator resumes;
 *  - `path.join` runs full path normalization per dirent (a dirent name can
 *    never contain a separator or a `..` segment, so joining with `path.sep` is
 *    byte-identical here).
 * Same traversal order (DFS, readdir order), same predicate, same skip list —
 * the returned array is element-for-element what the generator yielded.
 * Pinned by tests/build-perf-output-invariance-5130.test.ts against the
 * original generator.
 *
 * NOTE the skip list applies at EVERY depth, matching the pre-#5130 behaviour
 * (unlike blogImageCdnFinalizePlugin's `dir === root` gate). Do not "fix" that
 * here without a measurement: a nested `data/` slug carrying HTML would then
 * start being read on every build.
 */
export function collectHtml(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'assets' || entry.name === 'data' || entry.name === 'images') continue;
      collectHtml(dir + path.sep + entry.name, out);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      out.push(dir + path.sep + entry.name);
    }
  }
  return out;
}

export type IncrementalHtmlWalkResult = {
  readonly paths: readonly string[];
  readonly claimed: number;
  readonly targeted: number;
};

function isWalkableHtmlPath(distDir: string, filePath: string): boolean {
  if (!filePath.endsWith('.html')) return false;
  const relative = path.relative(distDir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep);
  return !segments.some((segment) => segment === 'assets' || segment === 'data' || segment === 'images');
}

/**
 * Rebuild the existence list from the current write registry and walk only
 * roots that were not claimed by an upstream emitter in the previous full
 * inventory. WriteCollector already visited the claimed paths while emitting
 * this build, so reopening their parent directories would only repeat the
 * 1.5M-entry filesystem walk.
 */
export function collectHtmlFromClaimedPaths(
  distDir: string,
  claimedPaths: Iterable<string>,
  targetedTopLevels: readonly string[],
): IncrementalHtmlWalkResult {
  const paths: string[] = [];
  const seen = new Set<string>();
  const claimedTopLevels = new Set<string>();
  const claimedChildrenByTopLevel = new Map<string, Set<string>>();
  let claimed = 0;
  for (const filePath of claimedPaths) {
    if (!isWalkableHtmlPath(distDir, filePath) || seen.has(filePath)) continue;
    seen.add(filePath);
    paths.push(filePath);
    const relative = path.relative(distDir, filePath);
    const segments = relative.split(path.sep);
    const topLevel = segments[0] || '<root>';
    claimedTopLevels.add(topLevel);
    if (segments.length > 1) {
      let children = claimedChildrenByTopLevel.get(topLevel);
      if (!children) {
        children = new Set<string>();
        claimedChildrenByTopLevel.set(topLevel, children);
      }
      children.add(segments[1]);
    }
    claimed++;
  }

  const rootsToWalk = new Set(targetedTopLevels);
  // A new direct emitter can introduce a top-level that was not present in
  // the previous inventory. The single shallow readdir is cheap and catches
  // that case without reopening any already-claimed tree.
  for (const entry of fs.readdirSync(distDir, { withFileTypes: true })) {
    if (entry.isDirectory() && (entry.name === 'assets' || entry.name === 'data' || entry.name === 'images')) {
      continue;
    }
    const topLevel = entry.isDirectory()
      ? entry.name
      : entry.isFile() && entry.name.endsWith('.html')
        ? '<root>'
        : null;
    if (topLevel !== null && !claimedTopLevels.has(topLevel)) rootsToWalk.add(topLevel);
  }

  const targetedPaths: string[] = [];
  for (const topLevel of [...rootsToWalk].sort()) {
    const root = topLevel === '<root>' ? distDir : path.join(distDir, topLevel);
    if (!fs.existsSync(root)) continue;
    collectHtml(root, targetedPaths);
  }
  // A direct fs emitter can add a new subtree below a top-level that already
  // has WriteCollector claims (most notably a locale root). Probe that one
  // directory level: existing claimed children remain covered by the registry,
  // while a new child is walked in full. This catches newly emitted HTML
  // without reopening the millions of already-claimed slug directories.
  for (const topLevel of [...claimedTopLevels].sort()) {
    const root = topLevel === '<root>' ? distDir : path.join(distDir, topLevel);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
    const claimedChildren = claimedChildrenByTopLevel.get(topLevel) ?? new Set<string>();
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.name === 'assets' || entry.name === 'data' || entry.name === 'images') continue;
      if (entry.isFile()) {
        if (entry.name.endsWith('.html')) targetedPaths.push(root + path.sep + entry.name);
        continue;
      }
      if (!entry.isDirectory()) continue;
      const childRoot = root + path.sep + entry.name;
      if (!claimedChildren.has(entry.name)) {
        collectHtml(childRoot, targetedPaths);
        continue;
      }
      // A claimed child can still receive a flat bridge or a new page
      // directory from an emitter that bypasses WriteCollector. Inspect only
      // this immediate level. Existing claimed page directories are identified
      // by their registered index.html and remain unopened; a directory without
      // that claim is new and can be walked safely in full.
      for (const childEntry of fs.readdirSync(childRoot, { withFileTypes: true })) {
        if (childEntry.name === 'assets' || childEntry.name === 'data' || childEntry.name === 'images') continue;
        if (childEntry.isFile()) {
          if (childEntry.name.endsWith('.html')) {
            targetedPaths.push(childRoot + path.sep + childEntry.name);
          }
          continue;
        }
        if (
          childEntry.isDirectory()
          && !seen.has(path.join(childRoot, childEntry.name, 'index.html'))
        ) {
          collectHtml(childRoot + path.sep + childEntry.name, targetedPaths);
        }
      }
    }
  }
  let targeted = 0;
  for (const filePath of targetedPaths) {
    if (!isWalkableHtmlPath(distDir, filePath) || seen.has(filePath)) continue;
    seen.add(filePath);
    paths.push(filePath);
    targeted++;
  }
  return { paths, claimed, targeted };
}
