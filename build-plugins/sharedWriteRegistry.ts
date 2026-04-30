/**
 * Shared write registry — deterministic single-owner-per-path enforcement.
 *
 * Why this exists
 * ---------------
 * Across the build, ~13 plugins all emit HTML under `dist/cerca-lavoro-ticino/`
 * (and several other shared trees) via `WriteCollector`. Each `WriteCollector`
 * eventually calls `fs.promises.writeFile` in parallel batches via `Promise.all`.
 * If two write sites — within the same plugin OR across two different plugins —
 * target the same `filePath` with non-identical content, the OS resolves the
 * race non-deterministically and the "winner" flips between builds. This was
 * the root cause of the 2026-04-30 incident where per-slug SEO pages
 * intermittently shipped without the SPA bundle script.
 *
 * Invariant enforced by this module
 * ---------------------------------
 *   For every `filePath` written to `dist/`, exactly ONE call site is the
 *   canonical owner of that path's content.
 *
 * `claim(path, plugin, content)` is the single entry point. Three outcomes:
 *
 *   1. **First claim** — registers the call site, returns `'allow-write'`.
 *
 *   2. **Idempotent re-claim** — same path, content hash identical to the
 *      previous claim. Returns `'skip-write'` (no-op write avoided). Safe and
 *      common: a per-slug loop that hits the same slug twice with the exact
 *      same rendered HTML is harmless and shouldn't fail the build.
 *
 *   3. **Collision** — same path, content hash DIFFERS. This is a bug
 *      (intra- or inter-plugin). Two outcomes depending on
 *      `WRITE_COLLISION_MODE`:
 *        - `throw` (target final state): raises `WriteCollisionError`,
 *          failing the build with both call sites + content hashes.
 *        - `report` (current default during migration): records the
 *          collision in a list for end-of-build summary, lets the build
 *          continue with last-writer-wins semantics. Used in PR1 to
 *          surface ALL existing collisions in one CI run.
 *
 *   Bypass for legitimate cross-plugin sharing: `declareSharedPath()` lets
 *   the project explicitly opt one plugin in as the canonical winner for a
 *   given path / pattern, with a documented reason. Any non-winner write to
 *   a declared shared path is silently skipped, never collides.
 *
 * Watch-mode safety
 * -----------------
 * `reset()` clears the in-flight claim map between builds. Vite's watch mode
 * keeps modules loaded across rebuilds, so without reset every save would
 * collide with the previous build's claims. Wired by
 * `writeRegistryLifecyclePlugin` (registered in vite.config.ts) which calls
 * reset at `buildStart` and prints the collision summary at the post-build
 * boundary.
 *
 * NOT THREAD-SAFE: this is a single-process build invariant. Worker threads
 * (e.g. postWalkCoordinator's per-file workers) operate on existing files
 * via direct `fs.writeFile`, not via WriteCollector — they bypass this
 * registry by design (post-processing existing claimed paths).
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type CollisionMode = 'report' | 'throw';

/**
 * One version of a write attempt for a given path. The registry accumulates
 * an array of these per path so end-of-build analysis can compare ALL the
 * variants ever proposed for that path (not just the last winner) and decide
 * which plugin should be the canonical owner.
 */
export interface ClaimVersion {
  readonly plugin: string;
  readonly callSite: string;
  readonly contentHash: string;
  /** Content length in bytes (UTF-8). Cheap signal of "richness". */
  readonly size: number;
  /** ms since the registry was last reset; useful for ordering across plugins. */
  readonly timestamp: number;
}

/**
 * @deprecated Kept for backward compatibility with existing tests. Prefer
 * {@link ClaimVersion} via {@link getPathHistory}. The legacy `Claim` shape
 * intentionally omits `size` and `timestamp` so older consumers don't see
 * fields they don't expect.
 */
interface Claim {
  readonly plugin: string;
  readonly callSite: string;
  readonly contentHash: string;
}

export interface CollisionRecord {
  readonly path: string;
  readonly first: Claim;
  readonly attempted: Claim;
}

export interface SharedPathDeclaration {
  /**
   * Either an exact path string (compared with strict equality) or a RegExp
   * tested against the path. Use a RegExp when the shared ownership covers
   * a family of paths under a slug pattern.
   */
  readonly pattern: string | RegExp;
  /**
   * Plugin name (matches the `pluginName` passed to `WriteCollector`) that
   * is allowed to write the canonical content. All other plugins' writes
   * to matching paths are silently skipped.
   */
  readonly winner: string;
  /**
   * Free-form rationale, kept in the source so future readers understand why
   * cross-plugin sharing was permitted instead of refactored away.
   */
  readonly reason: string;
}

/**
 * Module-scope state. Cleared per-build by {@link reset}.
 * `pathHistory` accumulates EVERY version of every path the registry sees;
 * the latest entry's `contentHash` is what's currently on disk (modulo the
 * pending parallel-flush race we exist to expose). End-of-build analysis
 * walks this map and finds paths whose `versions.length > 1` — those are
 * the collisions.
 */
const pathHistory = new Map<string, ClaimVersion[]>();
const sharedPathDeclarations: SharedPathDeclaration[] = [];

/**
 * Set of content hashes already dumped to disk. Each unique hash is written
 * at most once (the dump dir is content-addressed: filename = `${hash}.html`).
 */
const dumpedHashes = new Set<string>();

/**
 * Optional directory where every claim()'d content is dumped to disk for
 * end-of-build analysis. When `null`, no dump is performed (the default
 * for unit tests and ad-hoc runs). CI sets it via {@link configureDumpDir}
 * to enable post-mortem inspection of every version that ever competed for
 * a colliding path.
 */
let dumpContentDir: string | null = null;
let dumpDirMkdirDone = false;

/** Reference clock for {@link ClaimVersion.timestamp}. Reset by {@link reset}. */
let buildStartMs = Date.now();

/** Cache the mode so tests can override safely between calls to {@link setModeForTest}. */
let modeOverride: CollisionMode | null = null;

function currentMode(): CollisionMode {
  if (modeOverride !== null) return modeOverride;
  const env = (process.env.WRITE_COLLISION_MODE || '').toLowerCase();
  return env === 'throw' ? 'throw' : 'report';
}

function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

/**
 * Best-effort caller location extraction from an Error stack. Cheap (~0.05 ms
 * on Node 22) and skipped when the stack is unavailable. Returns the first
 * frame outside this module, node internals, and node_modules — i.e. the
 * actual plugin call site that triggered the write.
 */
function detectCallSite(): string {
  const err = new Error();
  const stack = String(err.stack || '');
  if (!stack) return 'unknown';
  const lines = stack.split('\n').slice(1);
  for (const raw of lines) {
    const line = raw.trim().replace(/^at\s+/, '');
    if (!line) continue;
    if (line.includes('sharedWriteRegistry')) continue;
    if (line.includes('batchWrite')) continue;
    if (line.startsWith('node:')) continue;
    if (line.includes('node_modules')) continue;
    return line;
  }
  return 'unknown';
}

function findSharedPathDeclaration(claimPath: string): SharedPathDeclaration | undefined {
  for (const decl of sharedPathDeclarations) {
    if (typeof decl.pattern === 'string') {
      if (decl.pattern === claimPath) return decl;
    } else if (decl.pattern.test(claimPath)) {
      return decl;
    }
  }
  return undefined;
}

/**
 * Write the given content to `${dumpContentDir}/${contentHash}.html` if dumping
 * is enabled and we haven't already dumped this hash. Content-addressed naming
 * deduplicates automatically across plugins/paths.
 *
 * Failure modes are silent (mkdir + writeFile may fail in sandboxed
 * environments); the registry is a diagnostic tool and shouldn't crash the
 * build over a dump failure. The build's primary I/O is unaffected.
 */
function maybeDumpContent(contentHash: string, content: string): void {
  if (!dumpContentDir) return;
  if (dumpedHashes.has(contentHash)) return;
  try {
    if (!dumpDirMkdirDone) {
      fs.mkdirSync(dumpContentDir, { recursive: true });
      dumpDirMkdirDone = true;
    }
    fs.writeFileSync(path.join(dumpContentDir, `${contentHash}.html`), content, 'utf-8');
    dumpedHashes.add(contentHash);
  } catch {
    // swallow — diagnostic only
  }
}

export class WriteCollisionError extends Error {
  readonly record: CollisionRecord;
  constructor(record: CollisionRecord) {
    super(formatCollisionMessage(record));
    this.name = 'WriteCollisionError';
    this.record = record;
  }
}

function formatCollisionMessage(record: CollisionRecord): string {
  const firstHash = record.first.contentHash.slice(0, 8);
  const attemptedHash = record.attempted.contentHash.slice(0, 8);
  return [
    `Write collision at ${record.path}`,
    `  Already claimed by: ${record.first.plugin} (${record.first.callSite})`,
    `  Now attempted by:   ${record.attempted.plugin} (${record.attempted.callSite})`,
    `  Content differs (hash ${firstHash} vs ${attemptedHash}).`,
    '',
    'Choose one:',
    '  1. Refactor so only one of the two writes — usually the right answer.',
    '  2. If both must coexist, call sharedWriteRegistry.declareSharedPath({',
    `       pattern: '${record.path}',`,
    `       winner: '${record.attempted.plugin}',  // or '${record.first.plugin}'`,
    `       reason: '...explain why both plugins legitimately target this path...',`,
    '     }) at module load time so the registry knows who wins.',
  ].join('\n');
}

export type ClaimOutcome = 'allow-write' | 'skip-write';

/**
 * Register or check a write attempt against the shared invariant.
 *
 * @returns `'allow-write'` when the caller may proceed to write the file;
 *          `'skip-write'` when the registry already has equivalent or winning
 *          content for this path and the caller should NOT write.
 *
 * @throws {WriteCollisionError} when {@link currentMode} is `'throw'` and the
 *         claim would conflict with an existing non-shared claim.
 */
export function claim(claimPath: string, plugin: string, content: string): ClaimOutcome {
  const contentHash = hashContent(content);
  const versions = pathHistory.get(claimPath);
  const newVersion = (): ClaimVersion => ({
    plugin,
    callSite: detectCallSite(),
    contentHash,
    size: Buffer.byteLength(content, 'utf-8'),
    timestamp: Date.now() - buildStartMs,
  });

  if (!versions) {
    pathHistory.set(claimPath, [newVersion()]);
    maybeDumpContent(contentHash, content);
    return 'allow-write';
  }

  // Idempotent: this exact content has already been written for this path
  // (by ANY plugin, at ANY prior time). Common, harmless, and silent.
  // We accept "saw this content before" rather than "matches the latest"
  // because plugin loops sometimes oscillate between equivalent renders.
  for (let i = 0; i < versions.length; i += 1) {
    if (versions[i].contentHash === contentHash) {
      return 'skip-write';
    }
  }

  // Declared shared path: the named winner appends a new version (and overwrites
  // on disk via last-writer-wins); everyone else stays out (skip-write).
  const decl = findSharedPathDeclaration(claimPath);
  if (decl) {
    if (decl.winner === plugin) {
      versions.push(newVersion());
      maybeDumpContent(contentHash, content);
      return 'allow-write';
    }
    return 'skip-write';
  }

  // Real collision: a new content for an already-claimed path with no shared
  // declaration. Record the new version so end-of-build analysis can compare
  // it against prior versions; whether the build aborts depends on mode.
  if (currentMode() === 'throw') {
    const previous = versions[versions.length - 1];
    const record: CollisionRecord = {
      path: claimPath,
      first: { plugin: previous.plugin, callSite: previous.callSite, contentHash: previous.contentHash },
      attempted: { plugin, callSite: detectCallSite(), contentHash },
    };
    throw new WriteCollisionError(record);
  }

  // report mode: append the new version, dump its content for analysis,
  // and let the parallel flush race normally (last-writer-wins on disk).
  // We surface every collision at end-of-build, not just the first.
  versions.push(newVersion());
  maybeDumpContent(contentHash, content);
  return 'allow-write';
}

/**
 * Declare that a path (or family of paths) is legitimately written by multiple
 * plugins, and that one of them wins. Loser plugins' writes are silently
 * skipped instead of colliding.
 *
 * Call this at module-load time of a plugin (top-level export) so the
 * declaration is registered before any `claim()` call. Declarations survive
 * {@link reset} (they're configuration, not state).
 */
export function declareSharedPath(decl: SharedPathDeclaration): void {
  sharedPathDeclarations.push(decl);
}

/**
 * Clear all claim history and dump dedup state for a fresh build. Does NOT
 * clear shared-path declarations or the configured dump directory — those are
 * configuration, not state. Called by `writeRegistryLifecyclePlugin` at
 * `buildStart` so watch-mode rebuilds don't carry stale claims.
 */
export function reset(): void {
  pathHistory.clear();
  dumpedHashes.clear();
  dumpDirMkdirDone = false;
  buildStartMs = Date.now();
}

/**
 * Read-only view of every path's full version history. Paths with
 * `versions.length === 1` had no collision; paths with `>= 2` had collisions
 * (one record per adjacent pair). End-of-build analysis (analyze-write-
 * collisions.mjs) iterates this map.
 */
export function getPathHistory(): ReadonlyMap<string, readonly ClaimVersion[]> {
  return pathHistory;
}

/**
 * Read-only view of collisions accumulated since the last {@link reset},
 * derived from {@link pathHistory}. Each adjacent pair of versions for a
 * path is one collision record.
 *
 * Paths covered by a {@link declareSharedPath} declaration are EXCLUDED
 * from the result: their multi-version history is intentional, not a
 * collision. Kept for backward compatibility with the legacy console-summary
 * code path; new analysis should walk {@link getPathHistory} directly and
 * apply its own filtering.
 */
export function getCollisions(): readonly CollisionRecord[] {
  const records: CollisionRecord[] = [];
  for (const [claimPath, versions] of pathHistory) {
    if (versions.length < 2) continue;
    if (findSharedPathDeclaration(claimPath)) continue;
    for (let i = 1; i < versions.length; i += 1) {
      const prev = versions[i - 1];
      const curr = versions[i];
      records.push({
        path: claimPath,
        first: { plugin: prev.plugin, callSite: prev.callSite, contentHash: prev.contentHash },
        attempted: { plugin: curr.plugin, callSite: curr.callSite, contentHash: curr.contentHash },
      });
    }
  }
  return records;
}

/** Read-only view of shared-path declarations active in the current process. */
export function getSharedPathDeclarations(): readonly SharedPathDeclaration[] {
  return sharedPathDeclarations;
}

/**
 * Configure where each unique-by-hash content gets dumped to disk during
 * `claim()`. Pass `null` to disable dumping (the default — keeps unit tests
 * and ad-hoc local builds from creating extra files). The lifecycle plugin
 * sets this from `WRITE_COLLISION_DUMP=1` + the project's dist directory.
 */
export function configureDumpDir(dir: string | null): void {
  dumpContentDir = dir;
  dumpDirMkdirDone = false;
}

/** Inspect the dump directory currently configured. Returns `null` when disabled. */
export function getDumpDir(): string | null {
  return dumpContentDir;
}

/**
 * Walk the dump directory and delete every `<hash>.html` file whose hash is
 * NOT referenced by a colliding path. After a typical build, this prunes
 * the dump from "every unique-by-hash content seen during the build"
 * (potentially gigabytes) down to "only the content of paths that actually
 * collided" (typically tens of MB). The lifecycle plugin invokes this after
 * writing the JSON report.
 */
export function pruneDumpToCollidingHashes(): { kept: number; removed: number } {
  if (!dumpContentDir) return { kept: 0, removed: 0 };

  const keepHashes = new Set<string>();
  for (const [, versions] of pathHistory) {
    if (versions.length < 2) continue;
    for (const v of versions) keepHashes.add(v.contentHash);
  }

  let kept = 0;
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dumpContentDir);
  } catch {
    return { kept: 0, removed: 0 };
  }

  for (const entry of entries) {
    if (!entry.endsWith('.html')) continue;
    const hash = entry.slice(0, -'.html'.length);
    if (keepHashes.has(hash)) {
      kept += 1;
    } else {
      try {
        fs.unlinkSync(path.join(dumpContentDir, entry));
        removed += 1;
      } catch {
        // ignore — diagnostic only
      }
    }
  }

  return { kept, removed };
}

/** Test-only override for {@link currentMode}. Pass `null` to revert to env. */
export function setModeForTest(mode: CollisionMode | null): void {
  modeOverride = mode;
}

/** Test-only: reset declarations as well. Production code must not call this. */
export function clearDeclarationsForTest(): void {
  sharedPathDeclarations.length = 0;
}
