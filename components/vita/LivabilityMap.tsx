import React from 'react';
import AvgRentValue from '@/components/shared/AvgRentValue';
import IrpefAddizionaleValue from '@/components/shared/IrpefAddizionaleValue';
import { CircleMarker, Tooltip } from 'react-leaflet';
import MapCanvas from '@/components/shared/MapCanvas';
import type { Municipality } from '@/data/municipalities';
import { MAP_COLORS } from '@/services/mapColors';

interface ScoredMunicipality extends Municipality {
 score: number;
 rank: number;
}

function scoreColor(score: number): string {
 if (score >= 0.7) return MAP_COLORS.positive;
 if (score >= 0.5) return MAP_COLORS.caution;
 return MAP_COLORS.negative;
}

export default function LivabilityMap({ municipalities }: { municipalities: ScoredMunicipality[] }) {
 // Center on Como area
 const center: [number, number] = [45.95, 9.05];

 return (
 <MapCanvas center={center} zoom={10}>
 {municipalities.map((m) => (
 <CircleMarker
 key={m.name}
 center={[m.lat, m.lng]}
 radius={Math.max(6, Math.min(14, m.score * 18))}
 pathOptions={{
 color: scoreColor(m.score),
 fillColor: scoreColor(m.score),
 fillOpacity: 0.7,
 weight: 2,
 }}
 >
 <Tooltip>
 <div className="text-sm">
 <p className="font-bold">{m.rank}. {m.name} ({m.province})</p>
 <p>Score: {(m.score * 100).toFixed(0)}/100</p>
 <p>{m.distanceKm} km — <AvgRentValue municipality={m} prefix="€ " suffix="/mese" /> — IRPEF <IrpefAddizionaleValue municipality={m} prefix="+" /></p>
 </div>
 </Tooltip>
 </CircleMarker>
 ))}
 </MapCanvas>
 );
}
