import { TARGET_CANTONS, SWISS_CANTONS, isTargetCanton } from './crawler-location-config.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');

// ── Load BFS municipality data + manual aliases from JSON ──
let _municipalityData = {};
let _aliasData = {};
try {
  _municipalityData = JSON.parse(readFileSync(join(DATA_DIR, 'canton-municipalities.json'), 'utf8'));
} catch { /* file missing or malformed — fall back to inline arrays */ }
try {
  _aliasData = JSON.parse(readFileSync(join(DATA_DIR, 'canton-location-aliases.json'), 'utf8'));
} catch { /* file missing — no aliases */ }

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

// Border proximity keywords by canton (Italian border → TI/GR, French border → VS)
export const BORDER_PROXIMITY_BY_CANTON = {
  TI: ['como', 'varese', 'lecco', 'novara', 'saronno', 'gallarate', 'busto arsizio', 'provincia di como', 'provincia di varese'],
  GR: ['chiavenna', 'sondrio', 'tirano'],
  VS: ['evian', 'thonon', 'saint-julien', 'annemasse', 'haute-savoie', 'pays du leman'],
};

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
  // Check remaining target cantons via generic isCantonRelevant
  for (const canton of TARGET_CANTONS) {
    if (canton === 'TI' || canton === 'GR') continue;
    if (isCantonRelevant(text, canton)) return canton;
  }
  return '';
}

/**
 * Infer canton code from text, checking ALL 26 Swiss cantons (not just target).
 * Useful when you need to know what canton a job is in regardless of target scope.
 */
export function inferAnyCanton(text = '') {
  // Check target cantons first (most common in our dataset)
  const target = inferSwissTargetCanton(text);
  if (target) return target;
  // Check all other cantons via their names/aliases (SWISS_CANTONS only, no BFS data for non-target)
  const lower = normalizeSwissTargetLocationText(text);
  if (!lower) return '';
  for (const [code, canton] of Object.entries(SWISS_CANTONS)) {
    if (TARGET_CANTONS.includes(code)) continue; // already checked
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
  // Check all TARGET_CANTONS via the generic isCantonRelevant
  for (const canton of TARGET_CANTONS) {
    if (canton === 'TI' || canton === 'GR') continue; // already checked above
    if (isCantonRelevant(text, canton) && isTargetCanton(canton)) return true;
  }
  return false;
}

// ── Generic canton relevance (JSON-driven) ──────────────────────────────────
// Cache of normalized city tokens per canton from JSON data
const _cantonCityTokensCache = new Map();

function getCantonCityTokens(cantonCode) {
  if (_cantonCityTokensCache.has(cantonCode)) return _cantonCityTokensCache.get(cantonCode);

  const tokens = new Set();
  // BFS municipalities from JSON
  const cantonData = _municipalityData?.cantons?.[cantonCode];
  if (cantonData?.municipalities) {
    for (const m of cantonData.municipalities) tokens.add(normalizeToken(m));
  }
  // Manual aliases from JSON
  const aliases = _aliasData?.[cantonCode];
  if (Array.isArray(aliases)) {
    for (const a of aliases) tokens.add(normalizeToken(a));
  }
  // SWISS_CANTONS names (from crawler-location-config)
  const cantonDef = SWISS_CANTONS[cantonCode];
  if (cantonDef?.names) {
    for (const name of cantonDef.names) tokens.add(normalizeToken(name));
  }

  const result = [...tokens].filter(Boolean);
  _cantonCityTokensCache.set(cantonCode, result);
  return result;
}

// Codes that are safe for word-boundary matching (won't false-positive on common words)
const SAFE_WORD_BOUNDARY_CODES = new Set(['TI', 'GR', 'VS', 'ZH', 'BE', 'LU', 'BS', 'AG', 'SG']);

/**
 * Generic canton relevance check — works for ANY canton using JSON data.
 * @param {string} text — location string to check
 * @param {string} cantonCode — 2-letter canton code (e.g., 'VS', 'TI', 'GR')
 * @returns {boolean}
 */
export function isCantonRelevant(text = '', cantonCode = '') {
  const lower = normalizeSwissTargetLocationText(text);
  if (!lower || !cantonCode) return false;

  const code = cantonCode.toUpperCase();

  // 1. Check SWISS_CANTONS names + BFS municipalities + aliases (all pre-tokenized)
  const cityTokens = getCantonCityTokens(code);
  if (hasToken(cityTokens, lower)) return true;

  // 2. Check canton code patterns: (TI), CH TI, 6900 TI
  const codeLower = code.toLowerCase();
  const codeEscaped = codeLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\(${codeEscaped}\\)`).test(lower)) return true;
  if (new RegExp(`\\bch\\s+${codeEscaped}\\b`).test(lower)) return true;
  if (new RegExp(`\\d{4}\\s+${codeEscaped}\\b`).test(lower)) return true;

  // 3. Bare word-boundary for safe codes only
  if (SAFE_WORD_BOUNDARY_CODES.has(code)) {
    if (new RegExp(`\\b${codeEscaped}\\b`).test(lower)) return true;
  }

  // 4. Border proximity keywords
  const borderKeywords = BORDER_PROXIMITY_BY_CANTON[code];
  if (borderKeywords?.some((kw) => lower.includes(kw))) return true;

  return false;
}

// Re-export for convenience
export { TARGET_CANTONS, isTargetCanton } from './crawler-location-config.mjs';
