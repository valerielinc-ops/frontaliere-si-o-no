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

export function getRegisteredRouteChunks(): string[] {
  return [...registeredRouteChunks].sort();
}

export function resetRegisteredRouteChunks(): void {
  registeredRouteChunks.clear();
  activeEmitters.clear();
  settledWaiters = [];
}
