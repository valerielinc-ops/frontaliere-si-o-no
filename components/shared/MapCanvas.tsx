import React, { useEffect, useState } from 'react';
import type { LatLngBoundsExpression, LatLngExpression } from 'leaflet';

/**
 * Shared Leaflet shell.
 *
 * Every map on the site used to repeat the same four things: the
 * `leaflet/dist/leaflet.css` import, a `<MapContainer>`, the identical OSM
 * `<TileLayer>` and its own reserved-height wrapper (the same 320px floor,
 * copy-pasted literally). Duplicated constants in ≥2 files drift, so they live
 * here once (AGENTS.md #6) and the callers keep only their own markers/dataset.
 *
 * Leaflet + react-leaflet + the CSS are loaded dynamically on mount: the
 * reserved box paints immediately at its declared height, so the async load
 * costs no layout shift (AGENTS.md #7 — reserve space, never suppress).
 */

/** OSM raster tiles — one config for every map. */
export const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

/** Reserved-height floor shared by every map box, in px. */
export const MAP_MIN_HEIGHT = 320;

export interface LeafletBundle {
  MapContainer: any;
  TileLayer: any;
  Marker: any;
  Popup: any;
  CircleMarker: any;
  Tooltip: any;
  L: any;
}

let bundlePromise: Promise<LeafletBundle> | null = null;

/** Load react-leaflet + leaflet + its CSS once, shared by every MapCanvas. */
function loadLeaflet(): Promise<LeafletBundle> {
  if (!bundlePromise) {
    bundlePromise = Promise.all([
      import('react-leaflet'),
      import('leaflet'),
      import('leaflet/dist/leaflet.css'),
    ]).then(([rl, leafletMod]) => {
      const mod: any = leafletMod;
      // Leaflet ships both a namespace and a default export depending on the build.
      const L: any = typeof mod?.divIcon === 'function' ? mod : mod.default;
      // Default marker icons resolve to bundler-relative URLs that break once
      // hashed; patch them once, globally.
      if (L?.Icon?.Default && !L.Icon.Default._patched) {
        delete (L.Icon.Default.prototype as any)._getIconUrl;
        L.Icon.Default.mergeOptions({
          iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
          iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
          shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
        });
        L.Icon.Default._patched = true;
      }
      return {
        MapContainer: rl.MapContainer,
        TileLayer: rl.TileLayer,
        Marker: rl.Marker,
        Popup: rl.Popup,
        CircleMarker: rl.CircleMarker,
        Tooltip: rl.Tooltip,
        L,
      };
    });
  }
  return bundlePromise;
}

export interface MapCanvasProps {
  center?: LatLngExpression;
  zoom?: number;
  bounds?: LatLngBoundsExpression;
  scrollWheelZoom?: boolean;
  /** CSS height of the reserved box. Default `100%` — the parent decides. */
  height?: string;
  /** Reserved min-height in px. Default {@link MAP_MIN_HEIGHT}. */
  minHeight?: number;
  /** Extra classes on the reserved box (border, radius, shadow…). */
  className?: string;
  /**
   * Mount the Leaflet instance. `false` keeps the reserved box but skips the
   * map: the responsive layouts render a mobile and a desktop twin and only
   * toggle CSS `display`, so mounting both doubles the init cost (#4302).
   */
  active?: boolean;
  /** Shown while leaflet loads, and while `active` is false. */
  placeholder?: React.ReactNode;
  ariaLabel?: string;
  tabIndex?: number;
  /**
   * Markers and overlays. A function receives the loaded bundle, so callers
   * that need `L` (custom icons) stay free of a static leaflet import.
   */
  children?: React.ReactNode | ((leaflet: LeafletBundle) => React.ReactNode);
}

export default function MapCanvas({
  center,
  zoom,
  bounds,
  scrollWheelZoom = true,
  height = '100%',
  minHeight = MAP_MIN_HEIGHT,
  className = '',
  active = true,
  placeholder = null,
  ariaLabel,
  tabIndex,
  children,
}: MapCanvasProps) {
  const [leaflet, setLeaflet] = useState<LeafletBundle | null>(null);

  useEffect(() => {
    if (!active) return;
    let mounted = true;
    loadLeaflet().then(bundle => {
      if (mounted) setLeaflet(bundle);
    });
    return () => { mounted = false; };
  }, [active]);

  const ready = active && leaflet !== null;
  // Capitalised locals: JSX cannot use a non-null-asserted member expression.
  const { MapContainer, TileLayer } = (leaflet ?? {}) as LeafletBundle;

  return (
    // `relative z-0` isolates Leaflet's high z-index panes from the page chrome.
    <div
      className={`relative z-0 ${className}`.trim()}
      style={{ height, minHeight }}
      aria-label={ariaLabel}
      tabIndex={tabIndex}
      aria-busy={active && !ready ? true : undefined}
    >
      {ready ? (
        <MapContainer
          center={center}
          zoom={zoom}
          bounds={bounds}
          scrollWheelZoom={scrollWheelZoom}
          className="h-full w-full"
        >
          <TileLayer attribution={OSM_ATTRIBUTION} url={OSM_TILE_URL} />
          {typeof children === 'function' ? children(leaflet!) : children}
        </MapContainer>
      ) : (
        placeholder
      )}
    </div>
  );
}
