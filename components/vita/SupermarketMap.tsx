import React, { useMemo } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { CHAIN_COLORS, type Supermarket } from '@/data/supermarketData';
import { MAP_COLORS } from '@/services/mapColors';

interface Props {
 supermarkets: Supermarket[];
}

/** Border crossing center (Chiasso area) — starting view for the map */
const MAP_CENTER: [number, number] = [45.95, 8.96];
const MAP_ZOOM = 10;

export default function SupermarketMap({ supermarkets }: Props) {
 const bounds = useMemo(() => {
 if (supermarkets.length === 0) return undefined;
 const lats = supermarkets.map(s => s.lat);
 const lngs = supermarkets.map(s => s.lng);
 return [
 [Math.min(...lats) - 0.02, Math.min(...lngs) - 0.02],
 [Math.max(...lats) + 0.02, Math.max(...lngs) + 0.02],
 ] as [[number, number], [number, number]];
 }, [supermarkets]);

 return (
 <MapContainer
 center={bounds ? undefined : MAP_CENTER}
 zoom={bounds ? undefined : MAP_ZOOM}
 bounds={bounds}
 scrollWheelZoom={false}
 className="h-[480px] w-full z-0"
 >
 <TileLayer
 attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
 url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
 />
 {supermarkets.map(s => (
 <CircleMarker
 key={s.id}
 center={[s.lat, s.lng]}
 radius={8}
 // Leaflet pathOptions — cannot use Tailwind, must remain hex values
 pathOptions={{
 fillColor: CHAIN_COLORS[s.chain] || MAP_COLORS.neutral,
 color: s.country === 'CH' ? MAP_COLORS.countryCH : MAP_COLORS.countryIT,
 weight: 2,
 fillOpacity: 0.85,
 }}
 >
 <Popup>
 <div className="text-sm">
 <div className="font-bold">
 {s.country === 'CH' ? '\uD83C\uDDE8\uD83C\uDDED' : '\uD83C\uDDEE\uD83C\uDDF9'}{' '}
 {s.name}
 </div>
 <div className="text-muted text-xs">
 {s.address}, {s.city}
 </div>
 <div className="text-xs mt-1">
 {/* Dynamic chain color — must use inline style as value comes from runtime map */}
 <span
 className="inline-block w-2.5 h-2.5 rounded-full mr-1"
 style={{ backgroundColor: CHAIN_COLORS[s.chain] || MAP_COLORS.neutral }}
 />
 {s.chain}
 </div>
 </div>
 </Popup>
 </CircleMarker>
 ))}
 </MapContainer>
 );
}
