import { MapContainer, CircleMarker, Popup, TileLayer, useMap } from 'react-leaflet';
import { useEffect } from 'react';
import 'leaflet/dist/leaflet.css';
import type { LatLngBoundsExpression, LatLngExpression } from 'leaflet';
import type { Pharmacy } from '@/services/pharmacies/types';

interface PharmacyMapProps {
  pharmacies: Pharmacy[];
  getHref: (pharmacy: Pharmacy) => string;
  openLabel: string;
  noLocationLabel: string;
}

function withCoordinates(pharmacies: Pharmacy[]): Pharmacy[] {
  return pharmacies.filter((pharmacy) => Number.isFinite(pharmacy.latitude) && Number.isFinite(pharmacy.longitude));
}

function MapViewport({ pharmacies }: { pharmacies: Pharmacy[] }) {
  const map = useMap();
  const coordinateKey = pharmacies.map((pharmacy) => `${pharmacy.id}:${pharmacy.latitude}:${pharmacy.longitude}`).join('|');
  useEffect(() => {
    if (pharmacies.length === 1) {
      map.setView([pharmacies[0].latitude!, pharmacies[0].longitude!], 16);
      return;
    }
    const bounds = pharmacies.map((pharmacy) => [pharmacy.latitude!, pharmacy.longitude!] as [number, number]) as LatLngBoundsExpression;
    map.fitBounds(bounds, { padding: [24, 24], maxZoom: 14 });
  }, [coordinateKey, map, pharmacies]);
  return null;
}

export default function PharmacyMap({ pharmacies, getHref, openLabel, noLocationLabel }: PharmacyMapProps) {
  const located = withCoordinates(pharmacies);
  if (!located.length) {
    return (
      <p className="rounded-xl border border-edge bg-surface-alt p-4 text-sm text-muted" role="status">
        {noLocationLabel}
      </p>
    );
  }

  const center = [located[0].latitude!, located[0].longitude!] as LatLngExpression;
  return (
    <div className="overflow-hidden rounded-2xl border border-edge bg-surface shadow-sm">
      <MapContainer
        center={center}
        zoom={located.length === 1 ? 16 : 10}
        scrollWheelZoom={false}
        className="h-[22rem] w-full sm:h-[28rem]"
        aria-label={openLabel}
      >
        <TileLayer
          attribution="&copy; OpenStreetMap contributors"
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <MapViewport pharmacies={located} />
        {located.map((pharmacy) => (
          <CircleMarker
            key={pharmacy.id}
            center={[pharmacy.latitude!, pharmacy.longitude!]}
            radius={8}
            pathOptions={{ color: '#0f766e', fillColor: '#14b8a6', fillOpacity: 0.85, weight: 2 }}
          >
            <Popup>
              <strong>{pharmacy.name}</strong>
              <br />
              {pharmacy.postalCode} {pharmacy.city}
              <br />
              <a href={getHref(pharmacy)}>{openLabel}</a>
            </Popup>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  );
}
