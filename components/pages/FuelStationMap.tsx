import React, { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup, Tooltip, useMap } from 'react-leaflet';
import { ExternalLink, LocateFixed, MapPin, RefreshCw, Search } from 'lucide-react';
import {
  FUEL_TYPE_LABEL,
  FUEL_ZONE_DISPLAY,
  buildFuelStationPath,
  type FuelDailyLocale,
  type FuelType,
  type FuelZone,
} from '@/build-plugins/fuelDailyData';
import {
  buildSwissStationSlug,
  fetchFuelPrices,
  zoneFromAddress,
  type FuelPricesDataset,
  type FuelStationSwitzerland,
} from '@/services/fuelPricesService';
import { MAP_COLORS } from '@/services/mapColors';
import 'leaflet/dist/leaflet.css';

export interface FuelMapStation {
  id: string;
  zone: FuelZone;
  slug: string;
  name: string;
  brand: string;
  address: string;
  href: string;
  lat: number;
  lng: number;
  benzinaPriceChf: number | null;
  dieselPriceChf: number | null;
}

export interface FuelStationMapPayload {
  locale: FuelDailyLocale;
  fuel: FuelType;
  updatedAt: string;
  stations: FuelMapStation[];
}

interface MapCopy {
  readonly search: string;
  readonly allZones: string;
  readonly stations: string;
  readonly cheapest: string;
  readonly listTitle: string;
  readonly openDetail: string;
  readonly directions: string;
  readonly source: string;
  readonly live: string;
  readonly loading: string;
  readonly fallback: string;
  readonly noResults: string;
  readonly mapHint: string;
  readonly highPrice: string;
  readonly fuelUnit: string;
}

const COPY: Record<FuelDailyLocale, MapCopy> = {
  it: {
    search: 'Cerca stazione o località',
    allZones: 'Tutte le zone',
    stations: 'stazioni',
    cheapest: 'Prezzo più basso',
    listTitle: 'Stazioni sulla mappa',
    openDetail: 'Apri pagina prezzo',
    directions: 'Indicazioni',
    source: 'TCS · aggiornamento automatico',
    live: 'Dati aggiornati',
    loading: 'Aggiorno i prezzi del giorno…',
    fallback: 'Snapshot del giorno',
    noResults: 'Nessuna stazione corrisponde ai filtri.',
    mapHint: 'Seleziona una stazione per evidenziarla sulla mappa.',
    highPrice: 'Prezzo più alto',
    fuelUnit: 'CHF/L',
  },
  en: {
    search: 'Search station or place',
    allZones: 'All zones',
    stations: 'stations',
    cheapest: 'Lowest price',
    listTitle: 'Stations on the map',
    openDetail: 'Open price page',
    directions: 'Directions',
    source: 'TCS · automatic refresh',
    live: 'Prices refreshed',
    loading: 'Refreshing today’s prices…',
    fallback: 'Daily snapshot',
    noResults: 'No station matches these filters.',
    mapHint: 'Select a station to highlight it on the map.',
    highPrice: 'Higher price',
    fuelUnit: 'CHF/L',
  },
  de: {
    search: 'Tankstelle oder Ort suchen',
    allZones: 'Alle Regionen',
    stations: 'Tankstellen',
    cheapest: 'Günstigster Preis',
    listTitle: 'Tankstellen auf der Karte',
    openDetail: 'Preisseite öffnen',
    directions: 'Route',
    source: 'TCS · automatische Aktualisierung',
    live: 'Preise aktualisiert',
    loading: 'Preise des Tages werden aktualisiert…',
    fallback: 'Statischer Tagesstand',
    noResults: 'Keine Tankstelle passt zu den Filtern.',
    mapHint: 'Wähle eine Tankstelle aus, um sie auf der Karte hervorzuheben.',
    highPrice: 'Höherer Preis',
    fuelUnit: 'CHF/L',
  },
  fr: {
    search: 'Rechercher une station ou un lieu',
    allZones: 'Toutes les zones',
    stations: 'stations',
    cheapest: 'Prix le plus bas',
    listTitle: 'Stations sur la carte',
    openDetail: 'Ouvrir la page prix',
    directions: 'Itinéraire',
    source: 'TCS · mise à jour automatique',
    live: 'Prix actualisés',
    loading: 'Actualisation des prix du jour…',
    fallback: 'Snapshot du jour',
    noResults: 'Aucune station ne correspond aux filtres.',
    mapHint: 'Sélectionnez une station pour la mettre en évidence sur la carte.',
    highPrice: 'Prix plus élevé',
    fuelUnit: 'CHF/L',
  },
};

const LOCALE_FOR_FORMAT: Record<FuelDailyLocale, string> = {
  it: 'it-CH',
  en: 'en-CH',
  de: 'de-CH',
  fr: 'fr-CH',
};

const TICINO_CENTER: [number, number] = [46.05, 8.95];

function stationKey(station: Pick<FuelMapStation, 'brand' | 'name' | 'address'>): string {
  return [station.brand, station.name, station.address]
    .map((value) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim())
    .join('|');
}

function priceForFuel(station: FuelStationSwitzerland, fuel: FuelType): number | null {
  if (fuel === 'benzina') {
    return typeof station.sp95PriceChf === 'number' && Number.isFinite(station.sp95PriceChf)
      ? station.sp95PriceChf
      : null;
  }
  const dieselPrice = station.dieselPriceChf;
  if (typeof dieselPrice === 'number' && Number.isFinite(dieselPrice)) return dieselPrice;
  // Keep the runtime fallback aligned with the build-time fuel pipeline for
  // older snapshots that only carry the SP95 value.
  return typeof station.sp95PriceChf === 'number' && Number.isFinite(station.sp95PriceChf)
    ? Number((station.sp95PriceChf + 0.08).toFixed(3))
    : null;
}

function fuelZoneFromAddress(address: string | null | undefined): FuelZone | null {
  const zone = zoneFromAddress(address);
  return zone && Object.prototype.hasOwnProperty.call(FUEL_ZONE_DISPLAY, zone)
    ? zone as FuelZone
    : null;
}

function priceForMap(station: FuelMapStation, fuel: FuelType): number | null {
  return fuel === 'benzina' ? station.benzinaPriceChf : station.dieselPriceChf;
}

function formatPrice(price: number | null, locale: FuelDailyLocale, unit: string): string {
  if (price == null || !Number.isFinite(price)) return '—';
  return `${new Intl.NumberFormat(LOCALE_FOR_FORMAT[locale], { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(price)} ${unit}`;
}

function formatDate(dateStamp: string, locale: FuelDailyLocale): string {
  const date = new Date(`${dateStamp.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateStamp;
  return new Intl.DateTimeFormat(LOCALE_FOR_FORMAT[locale], {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function normaliseInitialStations(payload: FuelStationMapPayload): FuelMapStation[] {
  return payload.stations.filter((station) =>
    Number.isFinite(station.lat) && Number.isFinite(station.lng) && priceForMap(station, payload.fuel) != null,
  );
}

function normaliseLiveStations(
  dataset: FuelPricesDataset,
  payload: FuelStationMapPayload,
): FuelMapStation[] {
  const fallbackByKey = new Map(payload.stations.map((station) => [stationKey(station), station]));
  const seen = new Set<string>();
  const result: FuelMapStation[] = [];

  for (const municipality of dataset.municipalities) {
    for (const station of municipality.swiss.nearbyStations) {
      const zone = fuelZoneFromAddress(station.address);
      const price = priceForFuel(station, payload.fuel);
      if (!zone || price == null || !Number.isFinite(station.lat) || !Number.isFinite(station.lng)) continue;
      const key = stationKey(station);
      if (seen.has(key)) continue;
      const fallback = fallbackByKey.get(key);
      // Runtime data may contain a newly added or renamed station before the
      // static SEO build emits its detail page. Keep the map's CTA closed over
      // the emitted payload instead of manufacturing a link that can 404.
      if (!fallback || fallback.zone !== zone) continue;
      seen.add(key);
      result.push({
        id: fallback.id,
        zone: fallback.zone,
        slug: fallback.slug,
        name: fallback.name,
        brand: fallback.brand,
        address: fallback.address,
        href: fallback.href,
        lat: station.lat,
        lng: station.lng,
        benzinaPriceChf: payload.fuel === 'benzina' ? price : (fallback?.benzinaPriceChf ?? null),
        dieselPriceChf: payload.fuel === 'diesel' ? price : (fallback?.dieselPriceChf ?? null),
      });
    }
  }
  return result;
}

function priceColor(price: number | null, min: number, max: number): string {
  if (price == null) return MAP_COLORS.neutral;
  const spread = max - min;
  const ratio = spread <= 0 ? 0 : (price - min) / spread;
  if (ratio <= 0.34) return MAP_COLORS.success;
  if (ratio <= 0.67) return MAP_COLORS.warning;
  return MAP_COLORS.danger;
}

function MapViewport({ stations, focused }: { stations: FuelMapStation[]; focused: FuelMapStation | null }) {
  const map = useMap();
  const bounds = useMemo(() => {
    if (stations.length === 0) return null;
    const lats = stations.map((station) => station.lat);
    const lngs = stations.map((station) => station.lng);
    return [[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]] as [[number, number], [number, number]];
  }, [stations]);

  useEffect(() => {
    if (bounds) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 13 });
  }, [bounds, map]);

  useEffect(() => {
    if (focused) map.flyTo([focused.lat, focused.lng], 14, { duration: 0.45 });
  }, [focused, map]);

  return null;
}

export default function FuelStationMap({ payload }: { payload: FuelStationMapPayload }) {
  const copy = COPY[payload.locale];
  const fuelLabel = FUEL_TYPE_LABEL[payload.locale][payload.fuel];
  const [stations, setStations] = useState<FuelMapStation[]>(() => normaliseInitialStations(payload));
  const [activeZone, setActiveZone] = useState<FuelZone | 'all'>('all');
  const [query, setQuery] = useState('');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(payload.updatedAt);

  useEffect(() => {
    let cancelled = false;
    setIsRefreshing(true);
    setRefreshFailed(false);
    fetchFuelPrices(false)
      .then((dataset) => {
        if (cancelled) return;
        const liveStations = normaliseLiveStations(dataset, payload);
        if (liveStations.length > 0) {
          const liveByKey = new Map(liveStations.map((station) => [stationKey(station), station]));
          setStations((current) => current.map((snapshot) => {
            const live = liveByKey.get(stationKey(snapshot));
            if (!live) return snapshot;
            return {
              ...snapshot,
              lat: live.lat,
              lng: live.lng,
              benzinaPriceChf: live.benzinaPriceChf ?? snapshot.benzinaPriceChf,
              dieselPriceChf: live.dieselPriceChf ?? snapshot.dieselPriceChf,
            };
          }));
        }
        if (dataset.generatedAt) setUpdatedAt(dataset.generatedAt.slice(0, 10));
      })
      .catch(() => {
        // The SSG payload is the deliberate offline fallback: the map stays
        // useful when Firestore/CDN data is unavailable.
        if (!cancelled) setRefreshFailed(true);
      })
      .finally(() => {
        if (!cancelled) setIsRefreshing(false);
      });
    return () => { cancelled = true; };
  }, [payload]);

  const visibleStations = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return stations
      .filter((station) => activeZone === 'all' || station.zone === activeZone)
      .filter((station) => !needle || `${station.name} ${station.brand} ${station.address}`.toLocaleLowerCase().includes(needle))
      .sort((a, b) => (priceForMap(a, payload.fuel) ?? Number.POSITIVE_INFINITY) - (priceForMap(b, payload.fuel) ?? Number.POSITIVE_INFINITY));
  }, [activeZone, payload.fuel, query, stations]);

  const prices = useMemo(
    () => stations.map((station) => priceForMap(station, payload.fuel)).filter((price): price is number => price != null && Number.isFinite(price)),
    [payload.fuel, stations],
  );
  const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
  const cheapest = visibleStations.find((station) => priceForMap(station, payload.fuel) != null) ?? null;
  const focused = visibleStations.find((station) => station.id === focusedId) ?? null;
  const zones: FuelZone[] = Array.from(new Set<FuelZone>(stations.map((station) => station.zone)));
  const bounds = useMemo(() => {
    if (visibleStations.length < 2) return undefined;
    const lats = visibleStations.map((station) => station.lat);
    const lngs = visibleStations.map((station) => station.lng);
    return [[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]] as [[number, number], [number, number]];
  }, [visibleStations]);

  return (
    <div className="fuel-map-shell fuel-map-enter">
      <div className="fuel-map-toolbar">
        <label className="fuel-map-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">{copy.search}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={copy.search}
            aria-label={copy.search}
          />
        </label>
        <div className="fuel-map-zone-filter" role="group" aria-label={copy.allZones}>
          <button type="button" aria-pressed={activeZone === 'all'} className={activeZone === 'all' ? 'is-active' : ''} onClick={() => setActiveZone('all')}>
            {copy.allZones}
          </button>
          {zones.map((zone) => (
            <button key={zone} type="button" aria-pressed={activeZone === zone} className={activeZone === zone ? 'is-active' : ''} onClick={() => setActiveZone(zone)}>
              {FUEL_ZONE_DISPLAY[zone]}
            </button>
          ))}
        </div>
      </div>

      <div className="fuel-map-grid">
        <div className="fuel-map-canvas-wrap">
          <div className="fuel-map-canvas-heading">
            <div>
              <strong>{fuelLabel}</strong>
              <span>{copy.mapHint}</span>
            </div>
            <div className="fuel-map-status" aria-live="polite">
              {isRefreshing ? <RefreshCw size={14} className="fuel-map-spin" aria-hidden="true" /> : <MapPin size={14} aria-hidden="true" />}
              {isRefreshing ? copy.loading : refreshFailed ? copy.fallback : `${copy.live} · ${visibleStations.length} ${copy.stations}`}
            </div>
          </div>
          <div className="fuel-map-canvas">
            <MapContainer
              center={TICINO_CENTER}
              zoom={10}
              bounds={bounds}
              scrollWheelZoom
              className="fuel-map-leaflet"
              aria-label={`${fuelLabel} — ${copy.listTitle}`}
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <MapViewport stations={visibleStations} focused={focused} />
              {visibleStations.map((station) => {
                const price = priceForMap(station, payload.fuel);
                const isFocused = station.id === focusedId;
                const color = priceColor(price, minPrice, maxPrice);
                return (
                  <CircleMarker
                    key={station.id}
                    center={[station.lat, station.lng]}
                    radius={isFocused ? 11 : 8}
                    eventHandlers={{ click: () => setFocusedId(station.id) }}
                    pathOptions={{ fillColor: color, color: isFocused ? MAP_COLORS.accent : MAP_COLORS.primaryStroke, weight: isFocused ? 4 : 2, fillOpacity: 0.92 }}
                  >
                    <Tooltip direction="top" offset={[0, -8]} opacity={0.96} permanent>
                      {formatPrice(price, payload.locale, copy.fuelUnit)}
                    </Tooltip>
                    <Popup>
                      <div className="fuel-map-popup">
                        <strong>{station.brand && station.brand !== station.name ? `${station.brand} · ` : ''}{station.name}</strong>
                        <span>{station.address}</span>
                        <b>{formatPrice(price, payload.locale, copy.fuelUnit)}</b>
                        <a href={station.href}>{copy.openDetail} <ExternalLink size={12} aria-hidden="true" /></a>
                      </div>
                    </Popup>
                  </CircleMarker>
                );
              })}
            </MapContainer>
          </div>
          <div className="fuel-map-legend" aria-label={copy.cheapest}>
            <span><i style={{ backgroundColor: MAP_COLORS.success }} /> {copy.cheapest}</span>
            <span><i style={{ backgroundColor: MAP_COLORS.warning }} /> {fuelLabel}</span>
            <span><i style={{ backgroundColor: MAP_COLORS.danger }} /> {copy.highPrice}</span>
          </div>
        </div>

        <aside className="fuel-map-list" aria-label={copy.listTitle}>
          <div className="fuel-map-list-heading">
            <div>
              <h3>{copy.listTitle}</h3>
              <p>{copy.source}</p>
            </div>
            {cheapest && (
              <div className="fuel-map-cheapest">
                <span>{copy.cheapest}</span>
                <strong>{formatPrice(priceForMap(cheapest, payload.fuel), payload.locale, copy.fuelUnit)}</strong>
              </div>
            )}
          </div>
          <div className="fuel-map-list-meta">
            <span>{visibleStations.length} {copy.stations}</span>
            <time dateTime={updatedAt}>{formatDate(updatedAt, payload.locale)}</time>
          </div>
          {visibleStations.length === 0 ? (
            <p className="fuel-map-empty">{copy.noResults}</p>
          ) : (
            <ol className="fuel-map-results">
              {visibleStations.map((station) => {
                const price = priceForMap(station, payload.fuel);
                const isFocused = station.id === focusedId;
                return (
                  <li key={station.id}>
                    <button type="button" className={`fuel-map-result ${isFocused ? 'is-selected' : ''}`} onClick={() => setFocusedId(station.id)}>
                      <span className="fuel-map-result-rank">{visibleStations.indexOf(station) + 1}</span>
                      <span className="fuel-map-result-copy">
                        <strong>{station.brand || station.name}</strong>
                        <small>{station.address}</small>
                      </span>
                      <b style={{ color: priceColor(price, minPrice, maxPrice) }}>{formatPrice(price, payload.locale, copy.fuelUnit)}</b>
                    </button>
                    <div className="fuel-map-result-links">
                      <a href={station.href}>{copy.openDetail}</a>
                      <a href={`https://www.google.com/maps/dir/?api=1&destination=${station.lat},${station.lng}`} target="_blank" rel="noreferrer">
                        <LocateFixed size={12} aria-hidden="true" /> {copy.directions}
                      </a>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </aside>
      </div>
    </div>
  );
}
