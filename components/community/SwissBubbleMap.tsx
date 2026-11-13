import { ArrowUpRight, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import municipalityMapData from '../../data/swiss-municipality-map.json';
import cantonBoundaryData from '../../data/swiss-canton-boundaries.json';
import { WEATHER_CANTON_CAPITALS } from '../../data/weatherCantonCapitals';

export interface CantonJobsData {
  cantonCode: string;
  name: string;
  count: number;
  href: string;
}

export interface CityJobsData {
  cantonCode: string;
  name: string;
  count: number;
}

export interface SwissBubbleMapCopy {
  allCantonsHeading: string;
  cantonHeading: (cantonName: string) => string;
  cantonsHeading: string;
  municipalitiesHeading: string;
  municipalityCount: (count: number) => string;
  municipalLogoNote: string;
  offerCount: (count: number) => string;
  viewJobs: string;
  noMunicipalities: string;
  unmappedOffers: (count: number) => string;
  closeDetails: (name: string) => string;
  mapAriaLabel: string;
  cantonsListAriaLabel: string;
  municipalitiesListAriaLabel: string;
  swisstopoAttribution: string;
  commonsAttribution: string;
  symbolSource: string;
}

export interface SwissBubbleMapProps {
  mode: 'national' | 'canton';
  cantonCodes: string[];
  cantons: CantonJobsData[];
  cities: CityJobsData[];
  totalJobsByCanton: Record<string, number>;
  locale: string;
  copy: SwissBubbleMapCopy;
  buildCityHref: (cantonCode: string, cityName: string) => string | null;
  onViewCityJobs: (cantonCode: string, cityName: string) => void;
}

interface CantonBoundaryDocument {
  cantons: Record<string, number[][][]>;
}

interface MapMunicipality {
  bfsCode: number;
  cantonCode: string;
  name: string;
  lat: number;
  lng: number;
  kind: 'coat-of-arms' | 'municipal-logo';
  commonsFile?: string;
  imageUrl?: string;
  sourceUrl?: string;
}

interface MapCantonSymbol {
  code: string;
  commonsFile: string;
}

interface SymbolImage {
  kind: 'coat-of-arms' | 'municipal-logo';
  commonsFile?: string;
  imageUrl?: string;
  sourceUrl?: string;
}

interface GeographicMarker extends SymbolImage {
  id: string;
  cantonCode: string;
  name: string;
  count: number;
  href: string | null;
  lat: number;
  lng: number;
}

interface PositionedMarker extends GeographicMarker {
  anchor: { x: number; y: number };
  point: { x: number; y: number };
}

interface Projection {
  height: number;
  project: (point: { lat: number; lng: number }) => { x: number; y: number };
}

const MAP_WIDTH = 1000;
const MAP_PADDING = 38;
const TICINO_CAPITAL_BFS_CODE = 5002;
const CITY_SYMBOLS_CATEGORY = 'https://commons.wikimedia.org/wiki/Category:Coats_of_arms_of_municipalities_of_Switzerland';
const CANTON_SYMBOLS_CATEGORY = 'https://commons.wikimedia.org/wiki/Category:Coats_of_arms_of_the_cantons_of_Switzerland';
const SWISSTOPO_HOME = 'https://www.swisstopo.admin.ch/';

const cantonBoundaries = cantonBoundaryData as CantonBoundaryDocument;
const municipalityMap = municipalityMapData as {
  cantons: MapCantonSymbol[];
  municipalities: MapMunicipality[];
};

function municipalityKey(value: string, cantonCode: string): string {
  return String(value || '')
    .replace(new RegExp(`\\s*\\(${cantonCode}\\)\\s*$`, 'i'), '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function imageForSymbol(symbol: SymbolImage): string | null {
  if (symbol.imageUrl) return symbol.imageUrl;
  if (!symbol.commonsFile) return null;
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(symbol.commonsFile)}?width=72`;
}

function sourceForSymbol(symbol: SymbolImage): string | null {
  if (symbol.sourceUrl) return symbol.sourceUrl;
  if (!symbol.commonsFile) return null;
  const title = encodeURIComponent(symbol.commonsFile.replace(/ /g, '_'));
  return `https://commons.wikimedia.org/wiki/File:${title}`;
}

function coordinatesOfBoundaryCode(code: string): Array<{ lat: number; lng: number }> {
  const polygons = cantonBoundaries.cantons[code] || [];
  const points: Array<{ lat: number; lng: number }> = [];
  for (const polygon of polygons) {
    const outerRing = polygon[0] || [];
    for (let index = 0; index + 1 < outerRing.length; index += 2) {
      points.push({ lng: outerRing[index], lat: outerRing[index + 1] });
    }
  }
  return points;
}

function createProjection(
  mode: SwissBubbleMapProps['mode'],
  cantonCodes: string[],
  markers: GeographicMarker[],
  mapWidth: number,
): Projection {
  const boundaryCodes = mode === 'national' ? Object.keys(cantonBoundaries.cantons) : cantonCodes;
  const allPoints = boundaryCodes.flatMap(coordinatesOfBoundaryCode);
  for (const marker of markers) allPoints.push({ lat: marker.lat, lng: marker.lng });

  const centerLatitude = allPoints.length
    ? (Math.min(...allPoints.map((point) => point.lat)) + Math.max(...allPoints.map((point) => point.lat))) / 2
    : 46.8;
  const longitudeScale = Math.cos((centerLatitude * Math.PI) / 180);
  const projectX = (lng: number) => lng * longitudeScale;
  const xs = allPoints.map((point) => projectX(point.lng));
  const ys = allPoints.map((point) => point.lat);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(0.1, maxX - minX);
  const spanY = Math.max(0.1, maxY - minY);
  const naturalHeight = Math.max(390, Math.min(700, Math.round(MAP_WIDTH * (spanY / spanX))));
  // Give dense mobile marker groups enough vertical room to spread without
  // obscuring the official symbols. The desktop projection keeps its current
  // compact proportions.
  const height = mapWidth > 0 && mapWidth < 520 ? Math.max(naturalHeight, 980) : naturalHeight;
  const scale = Math.min(
    (MAP_WIDTH - MAP_PADDING * 2) / spanX,
    (height - MAP_PADDING * 2) / spanY,
  );
  const offsetX = (MAP_WIDTH - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;

  return {
    height,
    project: ({ lat, lng }) => ({
      x: offsetX + (projectX(lng) - minX) * scale,
      y: offsetY + (maxY - lat) * scale,
    }),
  };
}

function pathForBoundary(polygons: number[][][], project: Projection['project']): string {
  return polygons.map((polygon) => polygon.map((ring) => {
    const commands: string[] = [];
    for (let index = 0; index + 1 < ring.length; index += 2) {
      const point = project({ lng: ring[index], lat: ring[index + 1] });
      commands.push(`${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`);
    }
    return commands.length > 0 ? `${commands.join('')}Z` : '';
  }).join(' ')).join(' ');
}

function offsetsForMarker(unitsPerPixel: number): Array<[number, number]> {
  const offsets: Array<[number, number]> = [[0, 0]];
  const spacing = 56 * unitsPerPixel;
  const directions: Array<[number, number]> = [[0, -1], [-1, 0], [-1, 1], [0, 1], [1, 0], [1, -1]];
  for (let ring = 1; ring <= 8; ring += 1) {
    let q = ring;
    let r = 0;
    for (const [dq, dr] of directions) {
      for (let step = 0; step < ring; step += 1) {
        offsets.push([
          (q + r / 2) * spacing,
          (r * Math.sqrt(3) / 2) * spacing,
        ]);
        q += dq;
        r += dr;
      }
    }
  }
  return offsets;
}

function spreadMarkers(
  markers: GeographicMarker[],
  projection: Projection,
  project: Projection['project'],
  mapWidth: number,
): PositionedMarker[] {
  const unitsPerPixel = MAP_WIDTH / Math.max(320, mapWidth);
  const minDistance = 52 * unitsPerPixel;
  const padding = 30 * unitsPerPixel;
  const placed: PositionedMarker[] = [];
  const ordered = [...markers].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const offsets = offsetsForMarker(unitsPerPixel);

  for (const marker of ordered) {
    const anchor = project({ lat: marker.lat, lng: marker.lng });
    const offset = offsets.find(([dx, dy]) => {
      const point = { x: anchor.x + dx, y: anchor.y + dy };
      if (point.x < padding || point.x > MAP_WIDTH - padding || point.y < padding || point.y > projection.height - padding) return false;
      return placed.every((existing) => Math.hypot(existing.point.x - point.x, existing.point.y - point.y) >= minDistance);
    }) || [0, 0];
    placed.push({ ...marker, anchor, point: { x: anchor.x + offset[0], y: anchor.y + offset[1] } });
  }

  return placed;
}

function SymbolImageView({ symbol, name, className, width, height }: {
  symbol: SymbolImage;
  name: string;
  className: string;
  width: number;
  height: number;
}) {
  const src = imageForSymbol(symbol);
  if (!src) return <span aria-hidden="true" className="inline-flex size-8 items-center justify-center rounded-full bg-accent-subtle text-xs font-bold text-accent">{name.slice(0, 2).toUpperCase()}</span>;
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      width={width}
      height={height}
      loading="lazy"
      decoding="async"
      className={className}
      onError={(event) => { event.currentTarget.hidden = true; }}
    />
  );
}

export const SwissBubbleMap: FC<SwissBubbleMapProps> = ({
  mode,
  cantonCodes,
  cantons,
  cities,
  totalJobsByCanton,
  locale,
  copy,
  buildCityHref,
  onViewCityJobs,
}) => {
  const mapRef = useRef<HTMLDivElement>(null);
  const [mapWidth, setMapWidth] = useState(0);
  const [activeMarkerId, setActiveMarkerId] = useState<string | null>(null);
  const cantonScopeKey = cantonCodes.join('|');

  useEffect(() => {
    const node = mapRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width || 0;
      setMapWidth((previous) => Math.abs(previous - width) > 1 ? width : previous);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setActiveMarkerId(null);
  }, [mode, cantonScopeKey]);

  const cantonDataByCode = useMemo(() => new Map(cantons.map((item) => [item.cantonCode, item])), [cantons]);
  const cantonSymbolsByCode = useMemo(() => new Map(municipalityMap.cantons.map((item) => [item.code, item])), []);

  const cityMarkers = useMemo(() => {
    if (mode !== 'canton') return [];
    const inScope = new Set(cantonCodes);
    const municipalitiesByName = new Map<string, MapMunicipality[]>();
    for (const municipality of municipalityMap.municipalities) {
      if (!inScope.has(municipality.cantonCode)) continue;
      const key = `${municipality.cantonCode}|${municipalityKey(municipality.name, municipality.cantonCode)}`;
      const candidates = municipalitiesByName.get(key) || [];
      candidates.push(municipality);
      municipalitiesByName.set(key, candidates);
    }

    const localityCounts = new Map<string, number>();
    for (const city of cities) {
      if (!inScope.has(city.cantonCode) || city.count <= 0) continue;
      const key = `${city.cantonCode}|${municipalityKey(city.name, city.cantonCode)}`;
      localityCounts.set(key, (localityCounts.get(key) || 0) + city.count);
    }

    const markers: GeographicMarker[] = [];
    for (const [key, count] of localityCounts) {
      const candidates = municipalitiesByName.get(key) || [];
      if (candidates.length !== 1) continue;
      const municipality = candidates[0];
      markers.push({
        id: `municipality-${municipality.bfsCode}`,
        cantonCode: municipality.cantonCode,
        name: municipality.name,
        count,
        href: buildCityHref(municipality.cantonCode, municipality.name),
        lat: municipality.lat,
        lng: municipality.lng,
        kind: municipality.kind,
        commonsFile: municipality.commonsFile,
        imageUrl: municipality.imageUrl,
        sourceUrl: municipality.sourceUrl,
      });
    }
    return markers.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, locale));
  }, [buildCityHref, cantonCodes, cities, locale, mode]);

  const mapMarkers = useMemo<GeographicMarker[]>(() => {
    if (mode === 'canton') return cityMarkers;
    return cantons.flatMap((canton) => {
      const capital = WEATHER_CANTON_CAPITALS.find((item) => item.canton === canton.cantonCode)
        || (canton.cantonCode === 'TI'
          ? municipalityMap.municipalities.find((item) => item.bfsCode === TICINO_CAPITAL_BFS_CODE)
          : undefined);
      const symbol = cantonSymbolsByCode.get(canton.cantonCode);
      if (!capital) return [];
      return [{
        id: `canton-${canton.cantonCode}`,
        cantonCode: canton.cantonCode,
        name: canton.name,
        count: canton.count,
        href: canton.href,
        lat: capital.lat,
        lng: capital.lng,
        kind: 'coat-of-arms' as const,
        commonsFile: symbol?.commonsFile,
      }];
    });
  }, [cantonSymbolsByCode, cantons, cityMarkers, mode]);

  const projection = useMemo(
    () => createProjection(mode, cantonCodes, mapMarkers, mapWidth),
    [cantonCodes, mapMarkers, mode, mapWidth],
  );
  const positionedMarkers = useMemo(
    () => spreadMarkers(mapMarkers, projection, projection.project, mapWidth || 580),
    [mapMarkers, mapWidth, projection],
  );
  const activeMarker = positionedMarkers.find((marker) => marker.id === activeMarkerId) || null;

  const cantonList = [...cantons].sort((a, b) => a.name.localeCompare(b.name, locale));
  const activeCityCount = cityMarkers.length;
  const mappedCityJobs = cityMarkers.reduce((sum, marker) => sum + marker.count, 0);
  const totalCantonJobs = cantonCodes.reduce((sum, code) => sum + (totalJobsByCanton[code] || 0), 0);
  const unmappedCityJobs = Math.max(0, totalCantonJobs - mappedCityJobs);
  const listEntries = mode === 'national' ? cantonList.map((item) => ({
    ...item,
    kind: 'coat-of-arms' as const,
    commonsFile: cantonSymbolsByCode.get(item.cantonCode)?.commonsFile,
    imageUrl: undefined,
    sourceUrl: undefined,
  })) : cityMarkers;
  const listHeading = mode === 'national' ? copy.cantonsHeading : copy.municipalitiesHeading;
  const listAriaLabel = mode === 'national' ? copy.cantonsListAriaLabel : copy.municipalitiesListAriaLabel;
  const markerHeading = mode === 'national'
    ? copy.allCantonsHeading
    : copy.cantonHeading(cantonCodes.map((code) => cantonDataByCode.get(code)?.name || code).join(' · '));
  const activeSymbolSource = activeMarker ? sourceForSymbol(activeMarker) : null;

  return (
    <div className="space-y-4" data-testid="swiss-bubble-map">
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(17rem,1fr)]">
        <div className="min-w-0">
          <h3 className="mb-2 text-base font-semibold font-display text-heading">{markerHeading}</h3>
          <div
            ref={mapRef}
            className="relative w-full overflow-hidden rounded-2xl border border-edge bg-surface-alt/70"
            style={{ aspectRatio: `${MAP_WIDTH} / ${projection.height}` }}
            role="region"
            aria-label={copy.mapAriaLabel}
            data-testid="swiss-map-canvas"
          >
            <svg
              viewBox={`0 0 ${MAP_WIDTH} ${projection.height}`}
              className="absolute inset-0 h-full w-full"
              aria-hidden="true"
              focusable="false"
            >
              {Object.entries(cantonBoundaries.cantons).map(([code, polygons]) => {
                const scoped = cantonCodes.includes(code);
                const active = mode === 'canton' && scoped;
                const hasOffers = (cantonDataByCode.get(code)?.count || 0) > 0;
                const fillClass = active
                  ? 'fill-accent-subtle'
                  : mode === 'national' && hasOffers
                    ? 'fill-accent-subtle'
                    : 'fill-surface';
                return (
                  <path
                    key={code}
                    d={pathForBoundary(polygons, projection.project)}
                    fillRule="evenodd"
                    className={`${fillClass} stroke-edge transition-colors`}
                    strokeWidth={active ? 1.8 : 1.2}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
              {positionedMarkers.map((marker) => marker.anchor.x !== marker.point.x || marker.anchor.y !== marker.point.y ? (
                <line
                  key={`connector-${marker.id}`}
                  x1={marker.anchor.x}
                  y1={marker.anchor.y}
                  x2={marker.point.x}
                  y2={marker.point.y}
                  className="stroke-accent-border"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null)}
            </svg>

            {positionedMarkers.map((marker) => {
              const selected = marker.id === activeMarkerId;
              const image = imageForSymbol(marker);
              return (
                <button
                  key={marker.id}
                  type="button"
                  onClick={() => setActiveMarkerId(selected ? null : marker.id)}
                  className={`absolute z-10 flex h-11 min-w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-surface shadow-md transition-[border-color,box-shadow,transform] hover:z-20 hover:scale-105 focus-visible:z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface ${selected ? 'border-accent ring-2 ring-accent/30' : 'border-edge'}`}
                  style={{ left: `${(marker.point.x / MAP_WIDTH) * 100}%`, top: `${(marker.point.y / projection.height) * 100}%` }}
                  aria-label={`${marker.name}, ${copy.offerCount(marker.count)}`}
                  aria-expanded={selected}
                  data-testid={`map-marker-${marker.id}`}
                >
                  <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center text-xs font-bold text-accent">{marker.cantonCode}</span>
                  {image && (
                    <img
                      src={image}
                      alt=""
                      aria-hidden="true"
                      width={28}
                      height={34}
                      loading="lazy"
                      decoding="async"
                      className="relative z-[1] max-h-[30px] max-w-[24px] object-contain"
                      onError={(event) => { event.currentTarget.hidden = true; }}
                    />
                  )}
                  <span aria-hidden="true" className="absolute -bottom-2 -right-2 hidden min-w-[1.35rem] rounded-full border border-surface bg-accent-strong px-1 py-0.5 text-center text-xs font-bold tabular-nums leading-none text-on-accent shadow-sm sm:block">
                    {marker.count.toLocaleString(locale)}
                  </span>
                </button>
              );
            })}

          </div>
          {activeMarker && (
            <div
              className="mt-3 rounded-xl border border-edge bg-surface p-3 shadow-sm"
              role="region"
              aria-label={activeMarker.name}
              aria-live="polite"
              data-testid="map-marker-details"
            >
              <div className="flex items-start gap-2">
                <div className="flex h-10 w-8 shrink-0 items-center justify-center">
                  <SymbolImageView key={activeMarker.id} symbol={activeMarker} name={activeMarker.name} className="max-h-9 max-w-7 object-contain" width={28} height={36} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold font-display text-heading">{activeMarker.name}</div>
                  <div className="mt-0.5 text-xs tabular-nums text-subtle">{copy.offerCount(activeMarker.count)}</div>
                  {activeMarker.kind === 'municipal-logo' && (
                    <div className="mt-1 text-xs leading-5 text-muted">{copy.municipalLogoNote}</div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setActiveMarkerId(null)}
                  className="inline-flex min-h-11 min-w-11 -mr-2 -mt-2 items-center justify-center rounded-lg text-muted hover:bg-surface-raised hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  aria-label={copy.closeDetails(activeMarker.name)}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-edge pt-2">
                {activeSymbolSource && (
                  <a href={activeSymbolSource} target="_blank" rel="noreferrer" className="text-xs font-medium text-subtle underline underline-offset-2 hover:text-heading">
                    {copy.symbolSource}
                  </a>
                )}
                {activeMarker.href ? (
                  <a href={activeMarker.href} className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-accent-strong px-3 text-xs font-semibold text-on-accent hover:bg-accent-strong-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2">
                    {copy.viewJobs}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                ) : (
                  <button type="button" onClick={() => onViewCityJobs(activeMarker.cantonCode, activeMarker.name)} className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-accent-strong px-3 text-xs font-semibold text-on-accent hover:bg-accent-strong-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2">
                    {copy.viewJobs}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          )}
          {mode === 'canton' && unmappedCityJobs > 0 && (
            <p className="mt-2 text-xs leading-5 text-muted">{copy.unmappedOffers(unmappedCityJobs)}</p>
          )}
        </div>

        <section aria-label={listAriaLabel} className="min-w-0">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h3 className="text-base font-semibold font-display text-heading">{listHeading}</h3>
            {mode === 'canton' && activeCityCount > 0 && (
              <span className="shrink-0 text-xs tabular-nums text-muted">{copy.municipalityCount(activeCityCount)}</span>
            )}
          </div>
          {listEntries.length === 0 ? (
            <p className="rounded-xl bg-surface-alt px-4 py-3 text-sm leading-6 text-subtle">{copy.noMunicipalities}</p>
          ) : (
            <ul className={`${mode === 'national' ? 'grid gap-x-4 sm:grid-cols-2 lg:grid-cols-1' : 'max-h-[28rem] overflow-y-auto pr-1'} divide-y divide-edge`}>
              {listEntries.map((entry) => {
                const symbol = entry as SymbolImage;
                const symbolSource = sourceForSymbol(symbol);
                return (
                  <li key={mode === 'national' ? entry.cantonCode : `${entry.cantonCode}-${entry.name}`} className="flex min-w-0 items-center gap-2.5 py-2.5 first:pt-1 last:pb-1">
                    {symbolSource ? (
                      <a href={symbolSource} target="_blank" rel="noreferrer" className="flex h-10 w-8 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={`${copy.symbolSource}: ${entry.name}`}>
                        <SymbolImageView symbol={symbol} name={entry.name} className="max-h-9 max-w-7 object-contain" width={28} height={36} />
                      </a>
                    ) : (
                      <span className="flex h-10 w-8 shrink-0 items-center justify-center rounded-md bg-accent-subtle text-xs font-bold text-accent" aria-label={copy.noMunicipalities}>{entry.cantonCode}</span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-heading">{entry.name}</div>
                      {symbol.kind === 'municipal-logo' && (
                        <div className="mt-0.5 text-xs leading-5 text-muted">{copy.municipalLogoNote}</div>
                      )}
                      <div className="mt-0.5 text-xs tabular-nums text-subtle">{copy.offerCount(entry.count)}</div>
                    </div>
                    {entry.href ? (
                      <a
                        href={entry.href}
                        className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-accent underline underline-offset-2 hover:bg-accent-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        aria-label={`${copy.viewJobs}: ${entry.name}`}
                      >
                        {copy.viewJobs}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </a>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onViewCityJobs(entry.cantonCode, entry.name)}
                        className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-accent underline underline-offset-2 hover:bg-accent-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        aria-label={`${copy.viewJobs}: ${entry.name}`}
                      >
                        {copy.viewJobs}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-edge pt-2 text-[11px] text-muted">
        <a href={SWISSTOPO_HOME} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-heading">{copy.swisstopoAttribution}</a>
        <a href={mode === 'national' ? CANTON_SYMBOLS_CATEGORY : CITY_SYMBOLS_CATEGORY} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-heading">{copy.commonsAttribution}</a>
        <span className="ml-auto text-right">
          {mode === 'national'
            ? copy.offerCount(cantons.reduce((sum, canton) => sum + canton.count, 0))
            : copy.offerCount(mappedCityJobs)}
        </span>
      </div>
    </div>
  );
};
