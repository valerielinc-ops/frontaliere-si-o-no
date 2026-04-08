import { TARGET_CANTONS, SWISS_CANTONS, isTargetCanton } from './crawler-location-config.mjs';

function normalizeSpace(value = '') {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeToken(value = '') {
  return normalizeSpace(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const BORDER_PROXIMITY_KEYWORDS = [
  'como',
  'varese',
  'lecco',
  'novara',
  'domodossola',
  'saronno',
  'gallarate',
  'busto arsizio',
  'provincia di como',
  'provincia di varese',
];

// Source: BFS AGV communes API, snapshot date 2025-12-01
// https://www.agvchapp.bfs.admin.ch/api/communes/levels?date=01-12-2025
export const TICINO_MUNICIPALITIES = [
  'Acquarossa', 'Agno', 'Airolo', 'Alto Malcantone', 'Aranno', 'Arbedo-Castione', 'Arogno',
  'Ascona', 'Avegno Gordevio', 'Balerna', 'Bedano', 'Bedretto', 'Bellinzona', 'Biasca',
  'Bioggio', 'Bissone', 'Blenio', 'Bosco/Gurin', 'Breggia', 'Brione sopra Minusio',
  'Brissago', 'Brusino Arsizio', 'Cademario', 'Cadempino', 'Cadenazzo', 'Campo (Vallemaggia)',
  'Canobbio', 'Capriasca', 'Caslano', 'Castel San Pietro', 'Centovalli', 'Cerentino', 'Cevio',
  'Chiasso', 'Coldrerio', "Collina d'Oro", 'Comano', 'Cugnasco-Gerra', 'Cureglia', 'Dalpe',
  'Faido', 'Gambarogno', 'Giornico', 'Gordola', 'Grancia', 'Gravesano', 'Isone', 'Lamone',
  'Lavertezzo', 'Lavizzara', 'Lema', 'Linescio', 'Locarno', 'Losone', 'Lugano', 'Lumino',
  'Maggia', 'Magliaso', 'Manno', 'Massagno', 'Melide', 'Mendrisio', 'Mergoscia',
  'Mezzovico-Vira', 'Minusio', 'Monteceneri', 'Morbio Inferiore', 'Morcote', 'Muralto',
  'Muzzano', 'Neggio', 'Novazzano', 'Onsernone', 'Origlio', 'Orselina', 'Paradiso',
  'Personico', 'Pollegio', 'Ponte Capriasca', 'Porza', 'Pura', 'Quinto', 'Riva San Vitale',
  'Riviera', 'Ronco sopra Ascona', "Sant'Antonino", 'Savosa', 'Serravalle', 'Sorengo',
  'Stabio', 'Tenero-Contra', 'Terre di Pedemonte', 'Torricella-Taverne', 'Tresa', 'Vacallo',
  'Val Mara', 'Vernate', 'Verzasca', 'Vezia', 'Vico Morcote',
];

export const TICINO_STATIC_TOKENS = [
  'ticino',
  'tessin',
  'cantone ticino',
  'canton ticino',
  'canton tessin',
  'mendrisiotto',
  'sopraceneri',
  'sottoceneri',
  'leventina',
  'vallemaggia',
  'gambarogno',
  'verzasca',
  'svizzera italiana',
];

export const GRIGIONI_MUNICIPALITIES = [
  'Albula/Alvra', 'Andeer', 'Arosa', 'Avers', 'Bergün Filisur', 'Bever', 'Bonaduz', 'Bregaglia',
  'Breil/Brigels', 'Brusio', 'Buseno', 'Calanca', 'Cama', 'Castaneda', 'Cazis',
  'Celerina/Schlarigna', 'Chur', 'Churwalden', 'Conters im Prättigau', 'Davos',
  'Disentis/Mustér', 'Domat/Ems', 'Domleschg', 'Falera', 'Felsberg', 'Ferrera', 'Fideris',
  'Flerden', 'Flims', 'Fläsch', 'Furna', 'Fürstenau', 'Grono', 'Grüsch', 'Ilanz/Glion', 'Jenaz',
  'Jenins', 'Klosters', 'Küblis', 'La Punt Chamues-ch', 'Laax', 'Landquart', 'Lantsch/Lenz',
  'Lostallo', 'Lumnezia', 'Luzein', 'Madulain', 'Maienfeld', 'Malans', 'Masein',
  'Medel (Lucmagn)', 'Mesocco', 'Muntogna da Schons', 'Obersaxen Mundaun', 'Pontresina',
  'Poschiavo', 'Rheinwald', 'Rhäzüns', 'Rongellen', 'Rossa', 'Rothenbrunnen', 'Roveredo (GR)',
  'S-chanf', 'Safiental', 'Sagogn', 'Samedan', 'Samnaun', 'San Vittore', 'Santa Maria in Calanca',
  'Scharans', 'Schiers', 'Schluein', 'Schmitten (GR)', 'Scuol', 'Seewis im Prättigau',
  'Sils im Domleschg', 'Sils im Engadin/Segl', 'Silvaplana', 'Soazza', 'St. Moritz', 'Sufers',
  'Sumvitg', 'Surses', 'Tamins', 'Thusis', 'Trimmis', 'Trin', 'Trun', 'Tschappina',
  'Tujetsch', 'Untervaz', 'Urmein', 'Val Müstair', 'Vals', 'Valsot', 'Vaz/Obervaz', 'Zernez',
  'Zillis-Reischen', 'Zizers', 'Zuoz',
];

export const GRIGIONI_STATIC_TOKENS = [
  'grigioni',
  'grischun',
  'grisons',
  'graubunden',
  'graubünden',
  'engadina',
  'engadin',
  'mesolcina',
  'calanca',
];

const TICINO_LOCATION_ALIASES = [
  'Giubiasco', 'Castione', 'Camorino', 'Rivera', 'Contone', 'Taverne', 'Magadino', 'Tenero',
  'Contra', 'Gudo', 'Iragna', 'Lodrino', 'Arbedo', 'Sementina', 'Pregassona', 'Breganzona',
  'Gentilino', 'Montagnola', 'Tesserete', 'Mezzovico', 'Ponte Tresa', 'Capolago', 'Maroggia',
  'Osogna', 'Preonzo', 'Cresciano', 'Curio', 'Novaggio', 'Miglieglia', 'Noranco', 'Pazzallo',
  'Barbengo', 'Agra', 'Vaglio', 'Sala Capriasca', 'Lugaggia', 'Croglio', 'Sessa', 'Astano',
  'Ritom', 'Piotta', 'Rodi', 'Ambrì', 'Cadro', 'Morcote', 'Carona', 'Viganello', 'Moleno',
];

const GRIGIONI_LOCATION_ALIASES = [
  'Coira', 'Grigioni italiano', 'Valposchiavo', 'Bassa Mesolcina', 'Moesa', 'St Moritz',
  'Saint-Moritz', 'Obervaz',
];

export const TICINO_CITIES = [...new Set([...TICINO_MUNICIPALITIES, ...TICINO_LOCATION_ALIASES])];
export const GRIGIONI_CITIES = [...new Set([...GRIGIONI_MUNICIPALITIES, ...GRIGIONI_LOCATION_ALIASES])];

const TICINO_CITY_TOKENS = TICINO_CITIES.map((city) => normalizeToken(city));
const GRIGIONI_CITY_TOKENS = GRIGIONI_CITIES.map((city) => normalizeToken(city));

function hasToken(tokens = [], lower = '') {
  return tokens.some((token) => {
    if (token.length < 6) {
      return new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower);
    }
    return lower.includes(token);
  });
}

export function normalizeSwissTargetLocationText(text = '') {
  return normalizeToken(text);
}

export function isTicinoRelevant(text = '') {
  const lower = normalizeSwissTargetLocationText(text);
  if (!lower) return false;
  if (hasToken([...TICINO_STATIC_TOKENS, ...TICINO_CITY_TOKENS], lower)) return true;
  if (/\(ti\)|\bch ti\b/i.test(lower)) return true;
  if (/\d{4}\s+ti\b/i.test(lower)) return true;
  if (/\bti\b/.test(lower)) return true;
  return BORDER_PROXIMITY_KEYWORDS.some((keyword) => lower.includes(keyword));
}

export function isGrigioniRelevant(text = '') {
  const lower = normalizeSwissTargetLocationText(text);
  if (!lower) return false;
  if (hasToken([...GRIGIONI_STATIC_TOKENS, ...GRIGIONI_CITY_TOKENS], lower)) return true;
  if (/\bgr\b/.test(lower)) return true;
  return false;
}

export function inferSwissTargetCanton(text = '') {
  if (isGrigioniRelevant(text)) return 'GR';
  if (isTicinoRelevant(text)) return 'TI';
  return '';
}

/**
 * Infer canton code from text, checking ALL 26 Swiss cantons (not just target).
 * Useful when you need to know what canton a job is in regardless of target scope.
 */
export function inferAnyCanton(text = '') {
  // Check TI/GR first (most common in our dataset)
  const target = inferSwissTargetCanton(text);
  if (target) return target;
  // Check all other cantons via their names/aliases
  const lower = normalizeSwissTargetLocationText(text);
  if (!lower) return '';
  for (const [code, canton] of Object.entries(SWISS_CANTONS)) {
    if (code === 'TI' || code === 'GR') continue; // already checked
    if (canton.names.some((name) => {
      const norm = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return norm.length < 6
        ? new RegExp(`\\b${norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower)
        : lower.includes(norm);
    })) {
      return code;
    }
  }
  return '';
}

export function normalizeCantonCode(raw = '') {
  const lower = normalizeSwissTargetLocationText(raw);
  if (!lower) return '';
  // Fast path for 2-letter codes
  const upper = lower.toUpperCase();
  if (SWISS_CANTONS[upper]) return upper;
  // Search all canton names/aliases
  for (const [code, canton] of Object.entries(SWISS_CANTONS)) {
    if (canton.names.some((name) => name === lower || lower === name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) {
      return code;
    }
  }
  return '';
}

export function isTargetSwissLocation(text = '', { includeGrigioni = true } = {}) {
  if (isTicinoRelevant(text) && isTargetCanton('TI')) return true;
  if (includeGrigioni && isGrigioniRelevant(text) && isTargetCanton('GR')) return true;
  // If TARGET_CANTONS includes cantons beyond TI/GR, check via inferAnyCanton
  const hasNonTiGr = TARGET_CANTONS.some((c) => c !== 'TI' && c !== 'GR');
  if (hasNonTiGr) {
    const canton = inferAnyCanton(text);
    if (canton && isTargetCanton(canton)) return true;
  }
  return false;
}

// Re-export for convenience
export { TARGET_CANTONS, isTargetCanton } from './crawler-location-config.mjs';
