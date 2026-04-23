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
  'banca-cler': { streetAddress: 'Piazza Grande 5', postalCode: '6600', addressLocality: 'Locarno', addressRegion: 'TI' },
  'ffs-officine-ferrovie-federali': { streetAddress: 'Via Ludovico Benteler 12', postalCode: '6500', addressLocality: 'Bellinzona', addressRegion: 'TI' },
  'ubs': { streetAddress: 'Via G. Calgari 2', postalCode: '6900', addressLocality: 'Lugano', addressRegion: 'TI' },
  'corner-banca': { streetAddress: 'Via Canova 16', postalCode: '6901', addressLocality: 'Lugano', addressRegion: 'TI' },
  'helsinn': { streetAddress: 'Via Pian Scairolo 9', postalCode: '6912', addressLocality: 'Lugano', addressRegion: 'TI' },
  'ibsa-institut-biochimique': { streetAddress: 'Via del Piano 29', postalCode: '6926', addressLocality: 'Montagnola', addressRegion: 'TI' },
  'medacta-international': { streetAddress: 'Strada Regina', postalCode: '6874', addressLocality: 'Castel San Pietro', addressRegion: 'TI' },
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
  const key = String(city).trim().toLowerCase();
  return CITY_TO_CANTON[key] || DEFAULT_CANTON_REGION;
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
  if (companySlug) {
    const hq = COMPANY_HQ_ADDRESSES[companySlug.toLowerCase()];
    if (hq) return hq;
  }
  if (city) {
    const cityHq = CITY_FALLBACK_ADDRESSES[city.toLowerCase()];
    if (cityHq) return cityHq;
  }
  // Canton-capital last resort (Ticino).
  return {
    streetAddress: 'Piazza Governo',
    postalCode: '6500',
    addressLocality: city || 'Bellinzona',
    addressRegion: deriveCantonFromCity(city),
  };
}
