import { borderCrossings, type BorderCrossing } from '@/data/borderCrossings';
import { haversineKm } from '../scripts/lib/haversine.mjs';

export interface NearestOpenCrossing {
  crossing: BorderCrossing;
  distanceKm: number;
}

// The municipality list asks for the same nearest crossing repeatedly. Keep
// the eligibility filter outside that hot path; each lookup is then one
// linear pass over the small, stable candidate set instead of a filter/map/
// full sort allocation for every municipality.
export const OPEN_BORDER_CROSSINGS: readonly BorderCrossing[] = borderCrossings.filter(
  (crossing) => crossing.trafficLevel !== 'closed',
);

/**
 * Returns the nearest currently open crossing and its already-computed
 * distance. A strict `<` preserves the first crossing on an exact tie, which
 * matches the previous stable-sort implementation while avoiding its full sort.
 */
export function nearestOpenCrossing(lat: number, lng: number): NearestOpenCrossing {
  const nearest = OPEN_BORDER_CROSSINGS.reduce<NearestOpenCrossing | null>((best, crossing) => {
    const distanceKm = haversineKm(lat, lng, crossing.lat, crossing.lng);
    return !best || distanceKm < best.distanceKm ? { crossing, distanceKm } : best;
  }, null);

  if (!nearest) throw new Error('No open border crossing is configured');
  return nearest;
}
