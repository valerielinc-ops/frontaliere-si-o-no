/**
 * Company HQ addresses registry — used as fallback for JobPosting structured data
 * when source job data lacks a valid streetAddress / postalCode.
 *
 * Shared by:
 *   - `jobsSeoPagesPlugin.ts` (per-job detail pages)
 *   - `weeklyEmployersPlugin.ts` (per-company × per-city weekly hubs)
 *
 * Keys are canonicalised company slugs (normEmployerKey output: lowercase,
 * diacritics stripped, non-alphanumerics collapsed to `-`). When a job has
 * no explicit HQ entry, callers MUST fall back to a city-level default and
 * ultimately to the canton-capital default — never emit empty fields (see
 * CLAUDE.md rule #3).
 */

export interface CompanyHqAddress {
  streetAddress: string;
  postalCode: string;
  addressLocality: string;
  /** Schema.org-compliant Swiss canton code (ISO 3166-2:CH suffix). */
  addressRegion: string;
}

/**
 * Canonical company-slug → HQ address. Keep in sync with new employer
 * onboarding (`services/employerBrands.ts`).
 */
export const COMPANY_HQ_ADDRESSES: Record<string, CompanyHqAddress> = {
  'eoc-ente-ospedaliero-cantonale': { streetAddress: 'Viale Officina 3', postalCode: '6500', addressLocality: 'Bellinzona', addressRegion: 'TI' },
  'ente-ospedaliero-cantonale-eoc': { streetAddress: 'Viale Officina 3', postalCode: '6500', addressLocality: 'Bellinzona', addressRegion: 'TI' },
  'lis-lugano-istituti-sociali': { streetAddress: 'Via alla Bozzoreda 15', postalCode: '6963', addressLocality: 'Pregassona', addressRegion: 'TI' },
  'amministrazione-cantonale-ti': { streetAddress: 'Piazza Governo', postalCode: '6501', addressLocality: 'Bellinzona', addressRegion: 'TI' },
  'migros-ticino': { streetAddress: 'Via Serrai 1', postalCode: '6592', addressLocality: 'S. Antonino', addressRegion: 'TI' },
  'coop-ticino': { streetAddress: 'Via Vedeggio 4', postalCode: '6805', addressLocality: 'Mezzovico', addressRegion: 'TI' },
  'vf-international-the-north-face-timberland': { streetAddress: 'Via Laveggio 5', postalCode: '6855', addressLocality: 'Stabio', addressRegion: 'TI' },
  'zurich-insurance-sede-ticino': { streetAddress: 'Via Pretorio 22', postalCode: '6900', addressLocality: 'Lugano', addressRegion: 'TI' },
  'banca-cler': { streetAddress: 'Aeschenplatz 3', postalCode: '4002', addressLocality: 'Basel', addressRegion: 'BS' },
  'ffs-officine-ferrovie-federali': { streetAddress: 'Via Ludovico Benteler 12', postalCode: '6500', addressLocality: 'Bellinzona', addressRegion: 'TI' },
  'ubs': { streetAddress: 'Via G. Calgari 2', postalCode: '6900', addressLocality: 'Lugano', addressRegion: 'TI' },
  'corner-banca': { streetAddress: 'Via Canova 16', postalCode: '6901', addressLocality: 'Lugano', addressRegion: 'TI' },
  'helsinn': { streetAddress: 'Via Pian Scairolo 9', postalCode: '6912', addressLocality: 'Lugano', addressRegion: 'TI' },
  'ibsa-institut-biochimique': { streetAddress: 'Via del Piano 29', postalCode: '6926', addressLocality: 'Montagnola', addressRegion: 'TI' },
  'medacta-international': { streetAddress: 'Strada Regina', postalCode: '6874', addressLocality: 'Castel San Pietro', addressRegion: 'TI' },
  microsoft: { streetAddress: 'The Circle 02', postalCode: '8058', addressLocality: 'Zürich', addressRegion: 'ZH' },
  'rsi-radiotelevisione-svizzera': { streetAddress: 'Via Canevascini 7', postalCode: '6903', addressLocality: 'Lugano', addressRegion: 'TI' },
  'usi-universita-della-svizzera-italiana': { streetAddress: 'Via G. Buffi 13', postalCode: '6904', addressLocality: 'Lugano', addressRegion: 'TI' },
  'supsi-dti': { streetAddress: 'Via Cantonale 2c', postalCode: '6928', addressLocality: 'Manno', addressRegion: 'TI' },
  // Graubünden companies
  'kantonsspital-graubunden-ksgr': { streetAddress: 'Loëstrasse 170', postalCode: '7000', addressLocality: 'Chur', addressRegion: 'GR' },
  'kantonsspital-graubunden': { streetAddress: 'Loëstrasse 170', postalCode: '7000', addressLocality: 'Chur', addressRegion: 'GR' },
  'tsmg': { streetAddress: 'Masanserstrasse 2', postalCode: '7000', addressLocality: 'Chur', addressRegion: 'GR' },
  // Ticino companies missing from original list
  'board-international': { streetAddress: 'Corso San Gottardo 46', postalCode: '6830', addressLocality: 'Chiasso', addressRegion: 'TI' },
  'alten-switzerland': { streetAddress: 'Via Industria 1', postalCode: '6855', addressLocality: 'Stabio', addressRegion: 'TI' },
  'fincons-group': { streetAddress: 'Via Cantonale 2a', postalCode: '6928', addressLocality: 'Manno', addressRegion: 'TI' },
  'fondazione-la-fonte': { streetAddress: 'Via Trevano 55', postalCode: '6900', addressLocality: 'Lugano', addressRegion: 'TI' },
  'bracco-suisse-s-a': { streetAddress: 'Via del Piano 29', postalCode: '6926', addressLocality: 'Montagnola', addressRegion: 'TI' },
  'bracco-suisse': { streetAddress: 'Via del Piano 29', postalCode: '6926', addressLocality: 'Montagnola', addressRegion: 'TI' },
  'bracco': { streetAddress: 'Via del Piano 29', postalCode: '6926', addressLocality: 'Montagnola', addressRegion: 'TI' },
  'schindler': { streetAddress: 'Via Cantonale 1', postalCode: '6532', addressLocality: 'Castione', addressRegion: 'TI' },
  'abb-svizzera-sede-ticino': { streetAddress: 'Via Cantonale 32', postalCode: '6572', addressLocality: 'Quartino', addressRegion: 'TI' },
  'abb': { streetAddress: 'Via Cantonale 32', postalCode: '6572', addressLocality: 'Quartino', addressRegion: 'TI' },
  'ruag-ag': { streetAddress: 'Via Campagna 1', postalCode: '6517', addressLocality: 'Arbedo', addressRegion: 'TI' },
  'post-ch-ag': { streetAddress: 'Piazza Stazione 1', postalCode: '6500', addressLocality: 'Bellinzona', addressRegion: 'TI' },
  'postfinance-ag': { streetAddress: 'Piazza Stazione 1', postalCode: '6500', addressLocality: 'Bellinzona', addressRegion: 'TI' },
  'ariston-group': { streetAddress: 'Via Cantonale 31', postalCode: '6930', addressLocality: 'Bedano', addressRegion: 'TI' },
  'skyguide': { streetAddress: 'Via Aeroporto', postalCode: '6982', addressLocality: 'Agno', addressRegion: 'TI' },
  'skyguide-sa': { streetAddress: 'Via Aeroporto', postalCode: '6982', addressLocality: 'Agno', addressRegion: 'TI' },
  'sunrise-communications-ag': { streetAddress: 'Via Cantonale 2c', postalCode: '6928', addressLocality: 'Manno', addressRegion: 'TI' },
  'zucchetti-switzerland-sa': { streetAddress: 'Via Dunant 7', postalCode: '6828', addressLocality: 'Balerna', addressRegion: 'TI' },
  'goline-sa': { streetAddress: 'Via Industria 5', postalCode: '6855', addressLocality: 'Stabio', addressRegion: 'TI' },
  'avaloq': { streetAddress: 'Via Cantonale 10', postalCode: '6900', addressLocality: 'Lugano', addressRegion: 'TI' },
  'lidl-svizzera': { streetAddress: 'Via Industria 6', postalCode: '6593', addressLocality: 'Cadenazzo', addressRegion: 'TI' },
  // Generic company keys used in expired job data (no region suffix)
  'coop': { streetAddress: 'Via Vedeggio 4', postalCode: '6805', addressLocality: 'Mezzovico', addressRegion: 'TI' },
  'galenica': { streetAddress: 'Untermattweg 8', postalCode: '3027', addressLocality: 'Bern', addressRegion: 'BE' },
  'fnz': { streetAddress: 'Via Cantonale 19', postalCode: '6900', addressLocality: 'Lugano', addressRegion: 'TI' },
  'fust': { streetAddress: 'Zürcherstrasse 22', postalCode: '9246', addressLocality: 'Niederbüren', addressRegion: 'SG' },
};

/**
 * City-level fallback addresses per known Ticino/Grigioni locality.
 * Used when a company has no HQ entry and the job lacks a valid
 * streetAddress — guarantees `streetAddress` is always present.
 */
export const CITY_FALLBACK_ADDRESSES: Record<string, CompanyHqAddress> = {
  'lugano': { streetAddress: 'Piazza Riforma 1', postalCode: '6900', addressLocality: 'Lugano', addressRegion: 'TI' },
  'mendrisio': { streetAddress: 'Via Luigi Benteler 1', postalCode: '6850', addressLocality: 'Mendrisio', addressRegion: 'TI' },
  'chiasso': { streetAddress: 'Corso San Gottardo 84', postalCode: '6830', addressLocality: 'Chiasso', addressRegion: 'TI' },
  'stabio': { streetAddress: 'Via Industria 1', postalCode: '6855', addressLocality: 'Stabio', addressRegion: 'TI' },
  'bellinzona': { streetAddress: 'Piazza Governo', postalCode: '6500', addressLocality: 'Bellinzona', addressRegion: 'TI' },
  'locarno': { streetAddress: 'Piazza Grande 18', postalCode: '6600', addressLocality: 'Locarno', addressRegion: 'TI' },
  'ticino': { streetAddress: 'Piazza Governo', postalCode: '6500', addressLocality: 'Bellinzona', addressRegion: 'TI' },
  // Major non-Ticino cities — used when a job sits outside Ticino (e.g. a
  // Swisscom posting in Zurich) so it never inherits a Ticino HQ address.
  'zürich': { streetAddress: 'Bahnhofstrasse 1', postalCode: '8001', addressLocality: 'Zürich', addressRegion: 'ZH' },
  'zurich': { streetAddress: 'Bahnhofstrasse 1', postalCode: '8001', addressLocality: 'Zürich', addressRegion: 'ZH' },
  'zurigo': { streetAddress: 'Bahnhofstrasse 1', postalCode: '8001', addressLocality: 'Zürich', addressRegion: 'ZH' },
  'winterthur': { streetAddress: 'Stadthausstrasse 4a', postalCode: '8400', addressLocality: 'Winterthur', addressRegion: 'ZH' },
  'bern': { streetAddress: 'Bundesplatz 3', postalCode: '3011', addressLocality: 'Bern', addressRegion: 'BE' },
  'berna': { streetAddress: 'Bundesplatz 3', postalCode: '3011', addressLocality: 'Bern', addressRegion: 'BE' },
  'genève': { streetAddress: "Rue de l'Hôtel-de-Ville 2", postalCode: '1204', addressLocality: 'Genève', addressRegion: 'GE' },
  'geneva': { streetAddress: "Rue de l'Hôtel-de-Ville 2", postalCode: '1204', addressLocality: 'Genève', addressRegion: 'GE' },
  'genf': { streetAddress: "Rue de l'Hôtel-de-Ville 2", postalCode: '1204', addressLocality: 'Genève', addressRegion: 'GE' },
  'ginevra': { streetAddress: "Rue de l'Hôtel-de-Ville 2", postalCode: '1204', addressLocality: 'Genève', addressRegion: 'GE' },
  'lausanne': { streetAddress: 'Place de la Palud 2', postalCode: '1003', addressLocality: 'Lausanne', addressRegion: 'VD' },
  'losanna': { streetAddress: 'Place de la Palud 2', postalCode: '1003', addressLocality: 'Lausanne', addressRegion: 'VD' },
  'vevey': { streetAddress: 'Grande Place 5', postalCode: '1800', addressLocality: 'Vevey', addressRegion: 'VD' },
  'basel': { streetAddress: 'Marktplatz 9', postalCode: '4001', addressLocality: 'Basel', addressRegion: 'BS' },
  'basilea': { streetAddress: 'Marktplatz 9', postalCode: '4001', addressLocality: 'Basel', addressRegion: 'BS' },
  'olten': { streetAddress: 'Hauptgasse 33', postalCode: '4600', addressLocality: 'Olten', addressRegion: 'SO' },
  'monthey': { streetAddress: "Place de l'Hôtel-de-Ville 1", postalCode: '1870', addressLocality: 'Monthey', addressRegion: 'VS' },
  'luzern': { streetAddress: 'Kornmarkt 3', postalCode: '6004', addressLocality: 'Luzern', addressRegion: 'LU' },
  'lucerna': { streetAddress: 'Kornmarkt 3', postalCode: '6004', addressLocality: 'Luzern', addressRegion: 'LU' },
  'zug': { streetAddress: 'Postplatz 1', postalCode: '6300', addressLocality: 'Zug', addressRegion: 'ZG' },
  'st. gallen': { streetAddress: 'Gallusstrasse 14', postalCode: '9000', addressLocality: 'St. Gallen', addressRegion: 'SG' },
  'san gallo': { streetAddress: 'Gallusstrasse 14', postalCode: '9000', addressLocality: 'St. Gallen', addressRegion: 'SG' },
};

/**
 * Canton (ISO 3166-2:CH suffix) → a central civic address in that canton's
 * capital. Last-resort fallback so a job in any canton resolves to a coherent
 * same-canton address instead of always defaulting to Bellinzona (Ticino).
 */
export const CANTON_CAPITAL_ADDRESSES: Record<string, CompanyHqAddress> = {
  TI: { streetAddress: 'Piazza Governo', postalCode: '6500', addressLocality: 'Bellinzona', addressRegion: 'TI' },
  ZH: { streetAddress: 'Bahnhofstrasse 1', postalCode: '8001', addressLocality: 'Zürich', addressRegion: 'ZH' },
  BE: { streetAddress: 'Bundesplatz 3', postalCode: '3011', addressLocality: 'Bern', addressRegion: 'BE' },
  GE: { streetAddress: "Rue de l'Hôtel-de-Ville 2", postalCode: '1204', addressLocality: 'Genève', addressRegion: 'GE' },
  VD: { streetAddress: 'Place de la Palud 2', postalCode: '1003', addressLocality: 'Lausanne', addressRegion: 'VD' },
  BS: { streetAddress: 'Marktplatz 9', postalCode: '4001', addressLocality: 'Basel', addressRegion: 'BS' },
  SO: { streetAddress: 'Hauptgasse 72', postalCode: '4500', addressLocality: 'Solothurn', addressRegion: 'SO' },
  VS: { streetAddress: 'Rue du Grand-Pont 12', postalCode: '1950', addressLocality: 'Sion', addressRegion: 'VS' },
  LU: { streetAddress: 'Kornmarkt 3', postalCode: '6004', addressLocality: 'Luzern', addressRegion: 'LU' },
  SG: { streetAddress: 'Gallusstrasse 14', postalCode: '9000', addressLocality: 'St. Gallen', addressRegion: 'SG' },
  ZG: { streetAddress: 'Postplatz 1', postalCode: '6300', addressLocality: 'Zug', addressRegion: 'ZG' },
  GR: { streetAddress: 'Poststrasse 33', postalCode: '7000', addressLocality: 'Chur', addressRegion: 'GR' },
  AG: { streetAddress: 'Rathausgasse 1', postalCode: '5000', addressLocality: 'Aarau', addressRegion: 'AG' },
  TG: { streetAddress: 'Rathausplatz 1', postalCode: '8500', addressLocality: 'Frauenfeld', addressRegion: 'TG' },
  SH: { streetAddress: 'Vordergasse 17', postalCode: '8200', addressLocality: 'Schaffhausen', addressRegion: 'SH' },
  FR: { streetAddress: "Place de l'Hôtel-de-Ville 1", postalCode: '1700', addressLocality: 'Fribourg', addressRegion: 'FR' },
  NE: { streetAddress: "Rue de l'Hôtel-de-Ville 1", postalCode: '2000', addressLocality: 'Neuchâtel', addressRegion: 'NE' },
};

/**
 * City name (lowercased, diacritics-tolerant) → Swiss canton code.
 * Used to derive `jobLocation.address.addressRegion` when the job's source
 * data lacks an explicit canton. Required by Google Search Console for
 * JobPosting rich-result quality (missing addressRegion is a non-critical
 * issue but counted in the GSC report — we treat it as deploy-blocking).
 */
export const CITY_TO_CANTON: Record<string, string> = {
  // Ticino
  'lugano': 'TI', 'bellinzona': 'TI', 'locarno': 'TI', 'mendrisio': 'TI', 'chiasso': 'TI',
  'biasca': 'TI', 'agno': 'TI', 'manno': 'TI', 'stabio': 'TI', 'giubiasco': 'TI',
  'ascona': 'TI', 'paradiso': 'TI', 'massagno': 'TI', 'cadenazzo': 'TI', 'mezzovico': 'TI',
  'balerna': 'TI', 'bedano': 'TI', 'airolo': 'TI', 'faido': 'TI', 'rivera': 'TI',
  'castione': 'TI', 'arbedo': 'TI', 'pregassona': 'TI', 'montagnola': 'TI', 'castel san pietro': 'TI',
  'quartino': 'TI', 's. antonino': 'TI', 'sant antonino': 'TI', 'ticino': 'TI',
  // Graubünden
  'chur': 'GR', 'coira': 'GR', 'davos': 'GR', 'st. moritz': 'GR', 'landquart': 'GR',
  'ilanz': 'GR', 'thusis': 'GR', 'poschiavo': 'GR', 'samedan': 'GR',
  // Major Swiss cities
  'zürich': 'ZH', 'zurich': 'ZH', 'zurigo': 'ZH', 'winterthur': 'ZH', 'kloten': 'ZH',
  'dübendorf': 'ZH', 'dietlikon': 'ZH',
  'bern': 'BE', 'berna': 'BE', 'thun': 'BE', 'interlaken': 'BE',
  'basel': 'BS', 'basilea': 'BS',
  'genève': 'GE', 'ginevra': 'GE', 'genf': 'GE', 'geneva': 'GE', 'plan-les-ouates': 'GE',
  'lausanne': 'VD', 'losanna': 'VD',
  'luzern': 'LU', 'lucerna': 'LU', 'lucerne': 'LU',
  'st. gallen': 'SG', 'san gallo': 'SG', 'gossau': 'SG', 'niederbüren': 'SG',
  'aarau': 'AG', 'baden': 'AG', 'lenzburg': 'AG',
  'fribourg': 'FR', 'friburgo': 'FR',
  'neuchâtel': 'NE',
  'zug': 'ZG',
  'schaffhausen': 'SH',
  'solothurn': 'SO', 'olten': 'SO',
  'frauenfeld': 'TG',
  'sion': 'VS', 'brig': 'VS', 'visp': 'VS', 'sierre': 'VS', 'martigny': 'VS',
};

/**
 * Default Swiss canton when no other signal is available. Site is
 * Ticino-focused, so falling back to TI keeps the structured-data legal.
 */
export const DEFAULT_CANTON_REGION = 'TI';

/**
 * Derive canton (addressRegion) from a city name. Returns `DEFAULT_CANTON_REGION`
 * when the city is unknown — never returns empty.
 */
export function deriveCantonFromCity(city: string | undefined | null): string {
  if (!city) return DEFAULT_CANTON_REGION;
  const raw = String(city).trim().toLowerCase();
  if (CITY_TO_CANTON[raw]) return CITY_TO_CANTON[raw];
  // Tolerate decorated localities like "Geneva (Genève)" or "Chur, Graubünden"
  // by probing the bare name and any parenthetical/segment variant.
  const candidates = new Set<string>();
  const paren = raw.match(/\(([^)]+)\)/);
  if (paren) candidates.add(paren[1].trim());
  candidates.add(raw.replace(/\([^)]*\)/g, '').trim());
  for (const segment of raw.split(/[,·/]/)) candidates.add(segment.trim());
  for (const candidate of candidates) {
    if (candidate && CITY_TO_CANTON[candidate]) return CITY_TO_CANTON[candidate];
  }
  return DEFAULT_CANTON_REGION;
}

/**
 * Lookup a fallback HQ address by company slug, then by city name, with a
 * final canton-capital guarantee. Always returns a fully populated address —
 * never returns empty strings (CLAUDE.md rule #3).
 */
export function resolveFallbackAddress(
  companySlug: string | undefined,
  city: string | undefined,
): CompanyHqAddress {
  const cityCanton = deriveCantonFromCity(city);
  if (companySlug) {
    const hq = COMPANY_HQ_ADDRESSES[companySlug.toLowerCase()];
    // Only trust the curated HQ when the job's city is in the HQ's own canton.
    // A cross-canton job (e.g. a Zurich posting for a Ticino-seat employer)
    // must not inherit the HQ address — fall through to a city/canton lookup.
    if (hq && hq.addressRegion === cityCanton) return hq;
  }
  if (city) {
    const cityHq = CITY_FALLBACK_ADDRESSES[city.toLowerCase()];
    if (cityHq) return cityHq;
  }
  // Canton-capital last resort: a coherent same-canton address (never empty),
  // keeping the real locality when known.
  const capital = CANTON_CAPITAL_ADDRESSES[cityCanton] || CANTON_CAPITAL_ADDRESSES.TI;
  return {
    streetAddress: capital.streetAddress,
    postalCode: capital.postalCode,
    addressLocality: city || capital.addressLocality,
    addressRegion: cityCanton,
  };
}
