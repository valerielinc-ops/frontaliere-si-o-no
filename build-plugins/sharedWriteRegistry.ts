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

export type CollisionMode = 'report' | 'throw';

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

/** Module-scope state. Cleared per-build by {@link reset}. */
const claims = new Map<string, Claim>();
const collisions: CollisionRecord[] = [];
const sharedPathDeclarations: SharedPathDeclaration[] = [];

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

function findSharedPathDeclaration(path: string): SharedPathDeclaration | undefined {
  for (const decl of sharedPathDeclarations) {
    if (typeof decl.pattern === 'string') {
      if (decl.pattern === path) return decl;
    } else if (decl.pattern.test(path)) {
      return decl;
    }
  }
  return undefined;
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
export function claim(path: string, plugin: string, content: string): ClaimOutcome {
  const contentHash = hashContent(content);
  const existing = claims.get(path);

  if (!existing) {
    claims.set(path, { plugin, callSite: detectCallSite(), contentHash });
    return 'allow-write';
  }

  // Idempotent: same content in any caller is a no-op.
  if (existing.contentHash === contentHash) {
    return 'skip-write';
  }

  // Declared shared path: the named winner overwrites; everyone else stays out.
  const decl = findSharedPathDeclaration(path);
  if (decl) {
    if (decl.winner === plugin) {
      claims.set(path, { plugin, callSite: detectCallSite(), contentHash });
      return 'allow-write';
    }
    return 'skip-write';
  }

  // Real collision.
  const record: CollisionRecord = {
    path,
    first: existing,
    attempted: { plugin, callSite: detectCallSite(), contentHash },
  };
  collisions.push(record);

  if (currentMode() === 'throw') {
    throw new WriteCollisionError(record);
  }

  // report mode: keep the build going with last-writer-wins so we surface
  // ALL collisions at end-of-build, not just the first.
  claims.set(path, record.attempted);
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
 * Clear all claims and collision records for a fresh build. Does NOT clear
 * shared-path declarations. Called by `writeRegistryLifecyclePlugin` at
 * `buildStart` so watch-mode rebuilds don't carry stale state.
 */
export function reset(): void {
  claims.clear();
  collisions.length = 0;
}

/** Read-only view of collisions accumulated since the last {@link reset}. */
export function getCollisions(): readonly CollisionRecord[] {
  return collisions;
}

/** Read-only view of shared-path declarations active in the current process. */
export function getSharedPathDeclarations(): readonly SharedPathDeclaration[] {
  return sharedPathDeclarations;
}

/** Test-only override for {@link currentMode}. Pass `null` to revert to env. */
export function setModeForTest(mode: CollisionMode | null): void {
  modeOverride = mode;
}

/** Test-only: reset declarations as well. Production code must not call this. */
export function clearDeclarationsForTest(): void {
  sharedPathDeclarations.length = 0;
}
