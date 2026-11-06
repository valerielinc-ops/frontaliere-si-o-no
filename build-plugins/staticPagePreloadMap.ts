import { BORDER_MUNICIPALITY_HUB_PATH } from './borderMunicipalityData';

const ROUTE_PRELOAD_CHUNKS = new Map<string, readonly string[]>([
  ...Object.values(BORDER_MUNICIPALITY_HUB_PATH).map((path) => [path, ['FrontierGuide']] as const),
  ['/vivere-in-ticino/costo-della-vita/', ['CostOfLiving']],
]);

function normalizePath(inputPath: string): string {
  const path = inputPath.split(/[?#]/, 1)[0] || '/';
  return path.endsWith('/') ? path : `${path}/`;
}

/** Return the lazy chunk required by an exact route, if one is known. */
export function routePreloadChunksFor(pathname: string): readonly string[] | undefined {
  return ROUTE_PRELOAD_CHUNKS.get(normalizePath(pathname));
}

/** Prefer an exact-route chunk list, then retain the caller's section fallback. */
export function routeAwarePreloadChunksFor(
  pathname: string,
  sectionFallback: readonly string[] | undefined,
): readonly string[] | undefined {
  return routePreloadChunksFor(pathname) ?? sectionFallback;
}
