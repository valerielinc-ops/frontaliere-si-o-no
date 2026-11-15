/**
 * Route-chunk hints of a static page, read by the release bootstrap.
 *
 * The page HTML must never carry `<link rel="modulepreload">` to `/assets/`: the
 * executable graph lives under `/assets/releases/<BUILD_ID>/`
 * (versionedCdnAssetsPlugin), so a preload of a root alias downloads a SECOND copy
 * of the module that nothing ever executes. Measured live 2026-10-31 on
 * /cerca-lavoro-ticino/: vendor-react, it-core, it-calculator, JobBoard and
 * it-stats all fetched twice, about 1.1 MB decoded. Release URLs cannot go in the
 * HTML either, because they would rewrite every prerendered page on every deploy.
 *
 * So the page names its chunks in a `<meta>` and the bootstrap, which knows the
 * release id, turns them into preloads. The bootstrap only honours a name
 * registered here by the same build: early-boot.js reloads the page when a
 * `<link>` under /assets/ fails, so a chunk name from stale cached HTML must not
 * become a request.
 */
export const ROUTE_CHUNKS_META_NAME = 'frontaliere-route-chunks';

import { readStageHandoff, stageHandoffDir, writeStageHandoff } from './stageHandoff';

/** File name inside BUILD_STAGE_HANDOFF_DIR (see shared/stageHandoff.ts). */
export const ROUTE_CHUNKS_HANDOFF_FILE = 'route-chunks.json';

const registeredRouteChunks = new Set<string>();
const activeEmitters = new Set<object>();
let settledWaiters: Array<() => void> = [];

/**
 * Called from `buildStart`, so it happens before every `closeBundle` and only for
 * a plugin that really runs. The returned function ends the emission: call it in a
 * `finally`, because the bootstrap waits for it.
 *
 * The allowlist is global state filled during closeBundle, so reading it is only
 * correct once its writers have finished. `order: 'post'` + `sequential` give that
 * order today; this states it, instead of depending on how the hooks are sorted.
 */
export function declareRouteHintEmitter(): () => void {
  const emitter = {};
  activeEmitters.add(emitter);
  return () => {
    activeEmitters.delete(emitter);
    if (activeEmitters.size) return;
    for (const resolve of settledWaiters) resolve();
    settledWaiters = [];
  };
}

export function routeHintEmittersSettled(): Promise<void> {
  if (!activeEmitters.size) return Promise.resolve();
  return new Promise((resolve) => settledWaiters.push(resolve));
}

export function routeChunksMetaTag(chunks: ReadonlyArray<string | null | undefined>): string {
  const unique = [...new Set(chunks.filter((chunk): chunk is string => Boolean(chunk)))];
  if (!unique.length) return '';
  for (const chunk of unique) registeredRouteChunks.add(chunk);
  return `<meta name="${ROUTE_CHUNKS_META_NAME}" content="${unique.join(' ')}">`;
}

/**
 * Staged build: persist what THIS process registered, for the other one. The SPA
 * index.html is hinted by preloadLocalePlugin in the bundle process (it-core,
 * it-calculator, App); the versioned-CDN bootstrap that builds the allowlist runs in
 * the SSG process, whose own registry does not contain those. No-op without
 * BUILD_STAGE_HANDOFF_DIR.
 */
export function persistRegisteredRouteChunks(): void {
  writeStageHandoff(ROUTE_CHUNKS_HANDOFF_FILE, { version: 1, chunks: [...registeredRouteChunks].sort() });
}

/** `{ version: 1, chunks: string[] }` (possibly empty); anything else is null. */
export function parseRouteChunksHandoff(data: unknown): string[] | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const { version, chunks } = data as { version?: unknown; chunks?: unknown };
  if (version !== 1 || !Array.isArray(chunks) || !chunks.every((chunk) => typeof chunk === 'string')) return null;
  return chunks as string[];
}

/**
 * The allowlist of route chunks. In the SSG stage of a staged build the handoff from
 * the bundle process is REQUIRED: preloadLocalePlugin writes it on every closeBundle
 * path (even with no chunks), so a missing, unreadable or malformed file is a bundle
 * error, and returning the SSG process's own partial registry would silently ship an
 * incomplete bootstrap allowlist. Outside that stage (single build, bundle stage,
 * tests, no handoff dir) the behaviour is unchanged: in-memory registry, plus the
 * file when one is present and valid.
 */
export function getRegisteredRouteChunks(): string[] {
  const all = new Set(registeredRouteChunks);
  const handoff = readStageHandoff<unknown>(ROUTE_CHUNKS_HANDOFF_FILE);
  const required = process.env.BUILD_STAGE === 'ssg' && stageHandoffDir() !== null;
  if (handoff.status === 'ok') {
    const chunks = parseRouteChunksHandoff(handoff.data);
    if (chunks) {
      for (const chunk of chunks) if (chunk) all.add(chunk);
    } else if (required) {
      throw new Error(`[module-preloads] route chunks handoff at ${handoff.path} is malformed: expected { version: 1, chunks: string[] }`);
    }
  } else if (required && handoff.status === 'missing') {
    throw new Error(`[module-preloads] route chunks handoff missing at ${handoff.path}: the bundle stage did not write it`);
  } else if (required && handoff.status === 'unreadable') {
    throw new Error(`[module-preloads] route chunks handoff unreadable at ${handoff.path}: ${handoff.reason}`);
  }
  return [...all].sort();
}

export function resetRegisteredRouteChunks(): void {
  registeredRouteChunks.clear();
  activeEmitters.clear();
  settledWaiters = [];
}
