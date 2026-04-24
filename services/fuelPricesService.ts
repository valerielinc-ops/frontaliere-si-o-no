import { reportCaughtError } from '@/services/errorReporter';

export type FuelComparisonCountry = 'IT' | 'CH' | 'SAME' | 'NO_DATA';

export interface FuelStationItaly {
 id: string;
 stationName: string;
 brand: string;
 address: string;
 lat: number | null;
 lng: number | null;
 priceEur: number;
 isSelf: boolean;
 updatedAt: string | null;
}

export interface FuelStationSwitzerland {
 id: string;
 name: string;
 brand: string;
 address: string;
 lat: number;
 lng: number;
 sp95PriceChf: number;
 sp95PriceEur: number;
 updatedAt: string | null;
 nearestMunicipality: string | null;
 nearestMunicipalityDistanceKm: number;
 distanceKm?: number;
}

export interface MunicipalityFuelRow {
 municipality: string;
 province: string;
 lat: number;
 lng: number;
 distanceKm: number;
 fascia: string;
 italy: {
 stationCount: number;
 minPriceEur: number | null;
 avgPriceEur: number | null;
 maxPriceEur: number | null;
 minSelfPriceEur: number | null;
 minServedPriceEur: number | null;
 cheapestStation: FuelStationItaly | null;
 stations: FuelStationItaly[];
 };
 swiss: {
 searchRadiusKm: number;
 optionCount: number;
 cheapestStation: FuelStationSwitzerland | null;
 nearbyStations: FuelStationSwitzerland[];
 minPriceChf: number | null;
 minPriceEur: number | null;
 };
 comparison: {
 cheaperCountry: FuelComparisonCountry;
 priceDeltaEur: number | null;
 saving50LEur: number | null;
 };
}

export interface FuelPricesDataset {
 generatedAt: string;
 sources: {
 italy: { provider: string; priceSnapshotDate: string | null; stationsUrl: string; pricesUrl: string; };
 switzerland: { provider: string; providerUrl: string; stationCount: number; latestObservedUpdate: string | null; };
 exchangeRate: { provider: string; sourceUrl: string; chfPerEur: number; eurPerChf: number; };
 };
 summary: {
 municipalityCount: number;
 municipalitiesWithItalyPrices: number;
 municipalitiesWithSwissComparison: number;
 cheaperItalyCount: number;
 cheaperSwissCount: number;
 tieCount: number;
 cheapestItalyMunicipality: { municipality: string; province: string; minPriceEur: number; cheapestStation: FuelStationItaly | null; } | null;
 cheapestSwissStation: FuelStationSwitzerland | null;
 };
 rankings: {
 cheapestItalyMunicipalities: Array<{ municipality: string; province: string; minPriceEur: number; cheapestStation: FuelStationItaly | null; }>;
 cheapestSwissStations: FuelStationSwitzerland[];
 bestCrossBorderSavings: Array<{ municipality: string; province: string; cheaperCountry: FuelComparisonCountry; saving50LEur: number | null; italyPriceEur: number | null; swissPriceEur: number | null; swissPriceChf: number | null; swissStation: FuelStationSwitzerland | null; }>;
 };
 municipalities: MunicipalityFuelRow[];
}

// ─── Firestore document shapes ──────────────────────────────

interface FuelMetadataDoc {
 generatedAt: string;
 sources: FuelPricesDataset['sources'];
 summary: FuelPricesDataset['summary'];
 rankings: FuelPricesDataset['rankings'];
 municipalities: Array<{
 municipality: string; province: string; lat: number; lng: number;
 distanceKm: number; fascia: string; comparison: MunicipalityFuelRow['comparison'];
 }>;
}

interface FuelItalyDoc {
 municipalities: Array<{ municipality: string; province: string; italy: MunicipalityFuelRow['italy']; }>;
}

interface FuelSwitzerlandDoc {
 municipalities: Array<{ municipality: string; province: string; swiss: MunicipalityFuelRow['swiss']; }>;
}

const IS_TEST_ENV = import.meta.env.MODE === 'test';
const CACHE_TTL_MS = 30 * 60 * 1000;

let cache: FuelPricesDataset | null = null;
let cacheTimestamp = 0;

function isCacheFresh(): boolean {
 return cache !== null && (Date.now() - cacheTimestamp) < CACHE_TTL_MS;
}

async function fetchFromFirestore(): Promise<FuelPricesDataset> {
 const { getFirestore, doc, getDoc } = await import('firebase/firestore');
 const { getApp } = await import('@/services/firebase');
 const db = getFirestore(await getApp());

 const [metaSnap, italySnap, swissSnap] = await Promise.all([
 getDoc(doc(db, 'fuelPrices', 'metadata')),
 getDoc(doc(db, 'fuelPrices', 'italy')),
 getDoc(doc(db, 'fuelPrices', 'switzerland')),
 ]);

 if (!metaSnap.exists()) {
 throw new Error('Fuel prices metadata not found in Firestore');
 }

 const meta = metaSnap.data() as FuelMetadataDoc;
 const italyData = italySnap.exists() ? (italySnap.data() as FuelItalyDoc) : { municipalities: [] };
 const swissData = swissSnap.exists() ? (swissSnap.data() as FuelSwitzerlandDoc) : { municipalities: [] };

 const italyMap = new Map<string, MunicipalityFuelRow['italy']>();
 for (const row of italyData.municipalities) {
 italyMap.set(row.municipality + ':' + row.province, row.italy);
 }
 const swissMap = new Map<string, MunicipalityFuelRow['swiss']>();
 for (const row of swissData.municipalities) {
 swissMap.set(row.municipality + ':' + row.province, row.swiss);
 }

 const defaultItaly: MunicipalityFuelRow['italy'] = {
 stationCount: 0, minPriceEur: null, avgPriceEur: null, maxPriceEur: null,
 minSelfPriceEur: null, minServedPriceEur: null, cheapestStation: null, stations: [],
 };
 const defaultSwiss: MunicipalityFuelRow['swiss'] = {
 searchRadiusKm: 20, optionCount: 0, cheapestStation: null,
 nearbyStations: [], minPriceChf: null, minPriceEur: null,
 };

 const municipalities: MunicipalityFuelRow[] = meta.municipalities.map((base) => {
 const key = base.municipality + ':' + base.province;
 return {
 municipality: base.municipality, province: base.province,
 lat: base.lat, lng: base.lng, distanceKm: base.distanceKm, fascia: base.fascia,
 italy: italyMap.get(key) ?? defaultItaly,
 swiss: swissMap.get(key) ?? defaultSwiss,
 comparison: base.comparison,
 };
 });

 return { generatedAt: meta.generatedAt, sources: meta.sources, summary: meta.summary, rankings: meta.rankings, municipalities };
}

/** Fallback: fetch the daily JSON cache from the static build */
async function fetchFromStaticJson(forceRefresh: boolean): Promise<FuelPricesDataset> {
 const url = forceRefresh ? '/data/fuel-prices.json?t=' + Date.now() : '/data/fuel-prices.json';
 const response = await fetch(url, { cache: forceRefresh ? 'no-store' : 'default' });
 if (!response.ok) {
 throw new Error('Fuel static JSON unavailable (' + response.status + ')');
 }
 return response.json() as Promise<FuelPricesDataset>;
}

export async function fetchFuelPrices(forceRefresh = false): Promise<FuelPricesDataset> {
 if (!forceRefresh && isCacheFresh()) return cache!;
 if (IS_TEST_ENV) throw new Error('Fuel dataset unavailable in test environment');

 try {
 const dataset = await fetchFromFirestore();
 cache = dataset;
 cacheTimestamp = Date.now();
 return dataset;
 } catch (firestoreErr) {
 reportCaughtError(firestoreErr, 'fuelPrices.firestoreRead');
 try {
 const dataset = await fetchFromStaticJson(forceRefresh);
 cache = dataset;
 cacheTimestamp = Date.now();
 return dataset;
 } catch {
 if (cache) return cache;
 throw firestoreErr;
 }
 }
}

/**
 * Derive a stable slug for a Swiss fuel station — mirrors the build-plugin logic
 * in build-plugins/fuelDailyData.ts so the SPA can build deep-link URLs without
 * a server round-trip.
 *
 * Pattern: `{brand}-{street}` (house numbers stripped).
 * Example: `eni-via-compolongo`
 */
function slugifyForStation(raw: string | null | undefined): string {
  if (!raw) return '';
  return String(raw)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function buildSwissStationSlug(opts: {
  brand?: string | null;
  name?: string | null;
  address?: string | null;
}): string {
  const { brand, name, address } = opts;
  let street = '';
  if (address) {
    const firstPart = address.split(',')[0] ?? '';
    street = firstPart.replace(/\s+\d+[A-Za-z]?$/g, '').trim();
  }
  const brandClean = brand && brand.toUpperCase() !== 'UNDEFINED' ? brand : '';
  const firstNameWord = name ? name.split(/\s+/)[0] ?? '' : '';
  const prefix = brandClean || firstNameWord || 'stazione';
  const slug = slugifyForStation(`${prefix}-${street}`);
  return slug || slugifyForStation(name ?? '') || 'stazione';
}

/**
 * Derive the Ticino zone for a Swiss station address so the SPA can build the
 * correct deep-link URL. Returns null for addresses outside the 5 canonical zones.
 *
 * Mirrors extractCityFromAddress() + FUEL_CITY_TO_ZONE from
 * build-plugins/fuelDailyData.ts. Uses exact city matching on the last
 * comma-separated address segment (postal code stripped) to avoid false
 * positives like "Via Lugano" being mapped to the lugano zone.
 */
const CITY_TO_ZONE: Record<string, string> = {
  // Chiasso zone (Mendrisiotto south)
  chiasso: 'chiasso',
  balerna: 'chiasso',
  coldrerio: 'chiasso',
  vacallo: 'chiasso',
  novazzano: 'chiasso',
  'morbio inferiore': 'chiasso',
  // Mendrisio zone
  mendrisio: 'mendrisio',
  stabio: 'mendrisio',
  'san pietro di stabio': 'mendrisio',
  serfontana: 'mendrisio',
  // Lugano zone
  lugano: 'lugano',
  caslano: 'lugano',
  magliaso: 'lugano',
  bioggio: 'lugano',
  purasca: 'lugano',
  monteggio: 'lugano',
  'molinazzo di monteggio': 'lugano',
  molinazzo: 'lugano',
  gandria: 'lugano',
  cadempino: 'lugano',
  manno: 'lugano',
  tesserete: 'lugano',
  lugaggia: 'lugano',
  muzzano: 'lugano',
  morcote: 'lugano',
  // Bellinzona zone
  bellinzona: 'bellinzona',
  giubiasco: 'bellinzona',
  arbedo: 'bellinzona',
  roveredo: 'bellinzona',
  grono: 'bellinzona',
  'san vittore': 'bellinzona',
  cama: 'bellinzona',
  // Locarno zone
  locarno: 'locarno',
  brissago: 'locarno',
  'vira (gambarogno)': 'locarno',
  gordevio: 'locarno',
  giumaglio: 'locarno',
};

export function zoneFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address.split(',');
  if (parts.length === 0) return null;
  const last = (parts[parts.length - 1] ?? '').trim();
  const city = last.replace(/^\d{4,5}\s+/, '').trim().toLowerCase();
  if (!city) return null;
  return CITY_TO_ZONE[city] ?? null;
}
