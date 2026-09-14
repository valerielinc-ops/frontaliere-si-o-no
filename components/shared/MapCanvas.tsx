import React from 'react';
import { CircleMarker, MapContainer, Marker, Popup, TileLayer, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import type { LatLngBoundsExpression, LatLngExpression } from 'leaflet';
import 'leaflet/dist/leaflet.css';

/**
 * Shared Leaflet shell.
 *
 * Every map on the site used to repeat the same four things: the
 * `leaflet/dist/leaflet.css` import, a `<MapContainer>`, the identical OSM
 * `<TileLayer>` and its own reserved-height wrapper (the same 320px floor,
 * copy-pasted literally). Duplicated constants in ≥2 files drift, so they live
 * here once (AGENTS.md #6) and the callers keep only their own markers/dataset.
 *
 * The Leaflet shell is synchronous once the client bundle is mounted: the
 * reserved box paints immediately at its declared height, and live marker
 * children cannot be stranded behind a loader that tests or a slow chunk may
 * outlive (AGENTS.md #7 — reserve space, never suppress).
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

const leafletRuntime: any = L;

const leafletBundle: LeafletBundle = {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  CircleMarker,
  Tooltip,
  L: leafletRuntime,
};

// Default marker icons resolve to bundler-relative URLs that break once
// hashed; patch them once, globally.
if (leafletRuntime?.Icon?.Default && !leafletRuntime.Icon.Default._patched) {
  delete (leafletRuntime.Icon.Default.prototype as any)._getIconUrl;
  leafletRuntime.Icon.Default.mergeOptions({
    iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
    iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  });
  leafletRuntime.Icon.Default._patched = true;
}

export interface MapCanvasProps {
  center?: LatLngExpression;
  zoom?: number;
  bounds?: LatLngBoundsExpression;
  scrollWheelZoom?: boolean;
  /** CSS height of the reserved box. Omit it when `className` owns responsive height. */
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
  /** Shown while `active` is false. */
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
  height,
  minHeight = MAP_MIN_HEIGHT,
  className = '',
  active = true,
  placeholder = null,
  ariaLabel,
  tabIndex,
  children,
}: MapCanvasProps) {
  const ready = active;

  return (
    // `relative z-0` isolates Leaflet's high z-index panes from the page chrome.
    <div
      className={`relative z-0 ${className}`.trim()}
      style={{ height, minHeight }}
      aria-label={ariaLabel}
      tabIndex={tabIndex}
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
          {typeof children === 'function' ? children(leafletBundle) : children}
        </MapContainer>
      ) : (
        placeholder
      )}
    </div>
  );
}
