import React, { useMemo } from 'react';
import { CircleMarker, Popup } from 'react-leaflet';
import MapCanvas from '@/components/shared/MapCanvas';
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
 <MapCanvas
 center={bounds ? undefined : MAP_CENTER}
 zoom={bounds ? undefined : MAP_ZOOM}
 bounds={bounds}
 scrollWheelZoom={false}
 height="480px"
 >
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
 className="inline-block w-2.5 h-2.5 rounded-full mr-1 bg-[color:var(--chain-bg)]"
 style={{ ['--chain-bg']: CHAIN_COLORS[s.chain] || MAP_COLORS.neutral } as React.CSSProperties}
 />
 {s.chain}
 </div>
 </div>
 </Popup>
 </CircleMarker>
 ))}
 </MapCanvas>
 );
}
