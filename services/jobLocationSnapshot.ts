import { borderCrossings } from '../data/borderCrossings';
import type { BorderCrossingId } from './router';

type CrossingType = {
  id: BorderCrossingId;
  name: string;
  province: string;
};

type LocationSeed = {
  locality: string;
  postalCode: string;
  lat: number;
  lng: number;
  aliases?: string[];
};

type PostalSeed = {
  locality: string;
  postalCode: string;
  aliases?: string[];
};

const COMMUTER_FRIENDLY_IDS = new Set<BorderCrossingId>([
  'chiasso-centro',
  'chiasso-brogeda',
  'chiasso-strada',
  'gaggiolo',
  'san-pietro',
  'ponte-tresa',
  'porto-ceresio-brusino',
  'luino-fornasette',
]);

const LOCATION_SEEDS: LocationSeed[] = [
  { locality: 'Lugano', postalCode: '6900', lat: 46.0037, lng: 8.9511, aliases: ['lugano centro'] },
  { locality: 'Bellinzona', postalCode: '6500', lat: 46.1953, lng: 9.0187 },
  { locality: 'Mendrisio', postalCode: '6850', lat: 45.8707, lng: 8.9809 },
  { locality: 'Chiasso', postalCode: '6830', lat: 45.8350, lng: 9.0302 },
  { locality: 'Locarno', postalCode: '6600', lat: 46.1670, lng: 8.7978 },
  { locality: 'Ascona', postalCode: '6612', lat: 46.1547, lng: 8.7733 },
  { locality: 'Riazzino', postalCode: '6595', lat: 46.1748, lng: 8.8447 },
  { locality: 'Stabio', postalCode: '6855', lat: 45.8530, lng: 8.9420 },
  { locality: 'Manno', postalCode: '6928', lat: 46.0328, lng: 8.9177 },
  { locality: 'Balerna', postalCode: '6828', lat: 45.8495, lng: 9.0080 },
  { locality: 'Novazzano', postalCode: '6883', lat: 45.8401, lng: 8.9837 },
  { locality: 'Bioggio', postalCode: '6934', lat: 46.0139, lng: 8.9105 },
  { locality: 'Agno', postalCode: '6982', lat: 45.9982, lng: 8.9025 },
  { locality: 'Grancia', postalCode: '6916', lat: 45.9792, lng: 8.9234 },
  { locality: 'Canobbio', postalCode: '6952', lat: 46.0352, lng: 8.9576 },
  { locality: 'Giubiasco', postalCode: '6512', lat: 46.1728, lng: 9.0067 },
  { locality: 'Biasca', postalCode: '6710', lat: 46.3597, lng: 8.9693 },
  { locality: 'Cadenazzo', postalCode: '6593', lat: 46.1510, lng: 8.9497 },
  { locality: 'Tenero', postalCode: '6598', lat: 46.1814, lng: 8.8560, aliases: ['tenero-contra'] },
  { locality: 'Minusio', postalCode: '6648', lat: 46.1772, lng: 8.8146 },
  { locality: 'Muralto', postalCode: '6600', lat: 46.1738, lng: 8.7997 },
  { locality: 'Vezia', postalCode: '6943', lat: 46.0262, lng: 8.9352 },
  { locality: 'Bissone', postalCode: '6816', lat: 45.9542, lng: 8.9682 },
  { locality: 'Paradiso', postalCode: '6900', lat: 45.9907, lng: 8.9456 },
  { locality: 'Castel San Pietro', postalCode: '6874', lat: 45.8626, lng: 9.0088, aliases: ['rancate'] },
];

const POSTAL_FALLBACK_SEEDS: PostalSeed[] = [
  { locality: 'Massagno', postalCode: '6900' },
  { locality: 'Paradiso', postalCode: '6900' },
  { locality: 'Noranco', postalCode: '6900' },
  { locality: 'Viganello', postalCode: '6962' },
  { locality: 'Pregassona', postalCode: '6963' },
  { locality: 'Breganzona', postalCode: '6932' },
  { locality: 'Montagnola', postalCode: '6926' },
  { locality: 'Muzzano', postalCode: '6933' },
  { locality: 'Cadempino', postalCode: '6814' },
  { locality: 'Lamone', postalCode: '6814' },
  { locality: 'Comano', postalCode: '6949' },
  { locality: 'Tesserete', postalCode: '6950' },
  { locality: 'Capriasca', postalCode: '6950' },
  { locality: 'Cadro', postalCode: '6965', aliases: ['lugano-cadro'] },
  { locality: 'Pazzallo', postalCode: '6912' },
  { locality: 'Novaggio', postalCode: '6986' },
  { locality: 'Sementina', postalCode: '6514' },
  { locality: 'Camorino', postalCode: '6528' },
  { locality: 'Arbedo', postalCode: '6517' },
  { locality: 'Castione', postalCode: '6532' },
  { locality: "Sant'Antonino", postalCode: '6592', aliases: ['s. antonino', 's.antonino', 's antonino'] },
  { locality: 'Gordola', postalCode: '6596' },
  { locality: 'Tenero-Contra', postalCode: '6598', aliases: ['tenero'] },
  { locality: 'Losone', postalCode: '6616' },
  { locality: 'Magadino', postalCode: '6573' },
  { locality: 'Quartino', postalCode: '6572' },
  { locality: 'Coldrerio', postalCode: '6877' },
  { locality: 'Morbio Inferiore', postalCode: '6834' },
  { locality: 'Vacallo', postalCode: '6833' },
  { locality: 'Faido', postalCode: '6760' },
  { locality: 'Bodio', postalCode: '6743' },
  { locality: 'Mezzovico-Vira', postalCode: '6805', aliases: ['mezzovico'] },
  { locality: 'Monteceneri', postalCode: '6802', aliases: ['rivera'] },
  { locality: 'Torricella-Taverne', postalCode: '6807', aliases: ['taverne'] },
  { locality: 'Bedano', postalCode: '6930' },
  { locality: 'Pollegio', postalCode: '6742' },
  { locality: 'Chur', postalCode: '7000', aliases: ['coira'] },
  { locality: 'Landquart', postalCode: '7302' },
  { locality: 'Davos', postalCode: '7270' },
  { locality: 'Pontresina', postalCode: '7504' },
  { locality: 'Samedan', postalCode: '7503' },
  { locality: 'St. Moritz', postalCode: '7500', aliases: ['st moritz', 'saint-moritz'] },
  { locality: 'Ticino', postalCode: '6900', aliases: ['canton ticino'] },
  { locality: 'Grigioni', postalCode: '7000', aliases: ['canton grigioni', 'graubunden', 'graubünden', 'grisons'] },
];

const LOCATION_INDEX = LOCATION_SEEDS.flatMap((seed) => {
  const variants = new Set([
    seed.locality,
    ...(seed.aliases || []),
  ]);
  return [...variants].map((value) => ({
    key: normalize(value),
    seed,
  }));
}).sort((a, b) => b.key.length - a.key.length);

const POSTAL_INDEX = [...LOCATION_SEEDS, ...POSTAL_FALLBACK_SEEDS]
  .flatMap((seed) => {
    const variants = new Set([
      seed.locality,
      ...(seed.aliases || []),
    ]);
    return [...variants].map((value) => ({
      key: normalize(value),
      seed,
    }));
  })
  .sort((a, b) => b.key.length - a.key.length);

export interface JobLocationSnapshotResult {
  locality: string;
  postalCode?: string;
  crossings: CrossingType[];
}

function normalize(value = ''): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slugifyCrossingName(name: string): BorderCrossingId {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() as BorderCrossingId;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function inferSeed(locality: string, postalCode?: string): LocationSeed | null {
  const cleanPostal = String(postalCode || '').trim();
  if (cleanPostal) {
    const byPostal = LOCATION_SEEDS.find((seed) => seed.postalCode === cleanPostal);
    if (byPostal) return byPostal;
  }

  const normalized = normalize(locality);
  if (!normalized) return null;

  for (const candidate of LOCATION_INDEX) {
    if (normalized.includes(candidate.key)) return candidate.seed;
  }
  return null;
}

function isValidSwissPostalCode(value = ''): boolean {
  if (!/^[1-9]\d{3}$/.test(value)) return false;
  const numericValue = Number(value);
  return !(numericValue >= 2020 && numericValue <= 2039);
}

function extractInlinePostalCode(value = ''): string {
  const match = String(value || '').match(/\b([1-9]\d{3})\b/);
  const postalCode = match?.[1] || '';
  return isValidSwissPostalCode(postalCode) ? postalCode : '';
}

function inferPostalSeed(locality: string, postalCode?: string): PostalSeed | null {
  const cleanPostal = String(postalCode || '').trim();
  if (cleanPostal) {
    const byPostal = [...LOCATION_SEEDS, ...POSTAL_FALLBACK_SEEDS].find((seed) => seed.postalCode === cleanPostal);
    if (byPostal) return byPostal;
  }

  const normalized = normalize(locality);
  if (!normalized) return null;

  for (const candidate of POSTAL_INDEX) {
    if (normalized.includes(candidate.key)) return candidate.seed;
  }
  return null;
}

function rankCrossings(seed: LocationSeed): CrossingType[] {
  const preferredProvince = seed.lat >= 46.1 || seed.lng < 8.9 ? 'VA' : null;
  return borderCrossings
    .map((crossing) => {
      const id = slugifyCrossingName(crossing.name);
      const distance = haversineKm(seed.lat, seed.lng, crossing.lat, crossing.lng);
      const commuterPenalty = COMMUTER_FRIENDLY_IDS.has(id) ? 0 : 25;
      const typePenalty = crossing.type === 'autostrada' ? 0 : crossing.type === 'statale' ? 4 : 14;
      const trafficPenalty = crossing.trafficLevel === 'closed' ? 200 : 0;
      const customsPenalty = crossing.customsPresent ? 0 : 1;
      const provincePenalty = preferredProvince && crossing.province !== preferredProvince ? 18 : 0;
      return {
        id,
        name: crossing.name,
        province: crossing.province,
        score: distance + commuterPenalty + typePenalty + trafficPenalty + customsPenalty + provincePenalty,
      };
    })
    .filter((crossing) => Number.isFinite(crossing.score) && crossing.score < 200)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map(({ id, name, province }) => ({ id, name, province }));
}

export function getJobLocationSnapshot(input: {
  location?: string;
  addressLocality?: string;
  postalCode?: string;
}): JobLocationSnapshotResult | null {
  const locality = String(input.addressLocality || input.location || '').trim();
  if (!locality) return null;

  const seed = inferSeed(locality, input.postalCode);
  if (!seed) {
    return {
      locality,
      postalCode: String(input.postalCode || '').trim() || undefined,
      crossings: [],
    };
  }

  return {
    locality: seed.locality,
    postalCode: seed.postalCode,
    crossings: rankCrossings(seed),
  };
}

export function deriveJobPostalCode(input: {
  location?: string;
  addressLocality?: string;
  postalCode?: string;
}, fallbackPostalCode = '6900'): string {
  const explicitPostalCode = String(input.postalCode || '').trim();
  if (isValidSwissPostalCode(explicitPostalCode)) return explicitPostalCode;

  const locality = String(input.addressLocality || '').trim();
  const localityPostalCode = extractInlinePostalCode(locality);
  if (localityPostalCode) return localityPostalCode;
  const localitySeed = inferPostalSeed(locality);
  if (localitySeed) return localitySeed.postalCode;

  const location = String(input.location || '').trim();
  const locationPostalCode = extractInlinePostalCode(location);
  if (locationPostalCode) return locationPostalCode;
  const locationSeed = inferPostalSeed(location);
  if (locationSeed) return locationSeed.postalCode;

  return fallbackPostalCode;
}
