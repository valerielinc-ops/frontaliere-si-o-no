import { BORDER_MUNICIPALITY_HUB_PATH } from './borderMunicipalityData';

const ROUTE_PRELOAD_CHUNKS = new Map(
  Object.values(BORDER_MUNICIPALITY_HUB_PATH).map((path) => [path, ['FrontierGuide'] as const]),
);

function normalizePath(inputPath: string): string {
  const path = inputPath.split(/[?#]/, 1)[0] || '/';
  return path.endsWith('/') ? path : `${path}/`;
}

/** Return the lazy chunk required by an exact route, if one is known. */
export function routePreloadChunksFor(pathname: string): readonly string[] | undefined {
  return ROUTE_PRELOAD_CHUNKS.get(normalizePath(pathname));
}
