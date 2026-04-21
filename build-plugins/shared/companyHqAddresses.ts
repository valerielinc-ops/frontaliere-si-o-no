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
}

/**
 * Canonical company-slug → HQ address. Keep in sync with new employer
 * onboarding (`services/employerBrands.ts`).
 */
export const COMPANY_HQ_ADDRESSES: Record<string, CompanyHqAddress> = {
  'eoc-ente-ospedaliero-cantonale': { streetAddress: 'Viale Officina 3', postalCode: '6500', addressLocality: 'Bellinzona' },
  'ente-ospedaliero-cantonale-eoc': { streetAddress: 'Viale Officina 3', postalCode: '6500', addressLocality: 'Bellinzona' },
  'lis-lugano-istituti-sociali': { streetAddress: 'Via alla Bozzoreda 15', postalCode: '6963', addressLocality: 'Pregassona' },
  'amministrazione-cantonale-ti': { streetAddress: 'Piazza Governo', postalCode: '6501', addressLocality: 'Bellinzona' },
  'migros-ticino': { streetAddress: 'Via Serrai 1', postalCode: '6592', addressLocality: 'S. Antonino' },
  'coop-ticino': { streetAddress: 'Via Vedeggio 4', postalCode: '6805', addressLocality: 'Mezzovico' },
  'vf-international-the-north-face-timberland': { streetAddress: 'Via Laveggio 5', postalCode: '6855', addressLocality: 'Stabio' },
  'zurich-insurance-sede-ticino': { streetAddress: 'Via Pretorio 22', postalCode: '6900', addressLocality: 'Lugano' },
  'banca-cler': { streetAddress: 'Piazza Grande 5', postalCode: '6600', addressLocality: 'Locarno' },
  'ffs-officine-ferrovie-federali': { streetAddress: 'Via Ludovico Benteler 12', postalCode: '6500', addressLocality: 'Bellinzona' },
  'ubs': { streetAddress: 'Via G. Calgari 2', postalCode: '6900', addressLocality: 'Lugano' },
  'corner-banca': { streetAddress: 'Via Canova 16', postalCode: '6901', addressLocality: 'Lugano' },
  'helsinn': { streetAddress: 'Via Pian Scairolo 9', postalCode: '6912', addressLocality: 'Lugano' },
  'ibsa-institut-biochimique': { streetAddress: 'Via del Piano 29', postalCode: '6926', addressLocality: 'Montagnola' },
  'medacta-international': { streetAddress: 'Strada Regina', postalCode: '6874', addressLocality: 'Castel San Pietro' },
  'rsi-radiotelevisione-svizzera': { streetAddress: 'Via Canevascini 7', postalCode: '6903', addressLocality: 'Lugano' },
  'usi-universita-della-svizzera-italiana': { streetAddress: 'Via G. Buffi 13', postalCode: '6904', addressLocality: 'Lugano' },
  'supsi-dti': { streetAddress: 'Via Cantonale 2c', postalCode: '6928', addressLocality: 'Manno' },
  // Graubünden companies
  'kantonsspital-graubunden-ksgr': { streetAddress: 'Loëstrasse 170', postalCode: '7000', addressLocality: 'Chur' },
  'kantonsspital-graubunden': { streetAddress: 'Loëstrasse 170', postalCode: '7000', addressLocality: 'Chur' },
  'tsmg': { streetAddress: 'Masanserstrasse 2', postalCode: '7000', addressLocality: 'Chur' },
  // Ticino companies missing from original list
  'board-international': { streetAddress: 'Corso San Gottardo 46', postalCode: '6830', addressLocality: 'Chiasso' },
  'alten-switzerland': { streetAddress: 'Via Industria 1', postalCode: '6855', addressLocality: 'Stabio' },
  'fincons-group': { streetAddress: 'Via Cantonale 2a', postalCode: '6928', addressLocality: 'Manno' },
  'fondazione-la-fonte': { streetAddress: 'Via Trevano 55', postalCode: '6900', addressLocality: 'Lugano' },
  'bracco-suisse-s-a': { streetAddress: 'Via del Piano 29', postalCode: '6926', addressLocality: 'Montagnola' },
  'bracco-suisse': { streetAddress: 'Via del Piano 29', postalCode: '6926', addressLocality: 'Montagnola' },
  'bracco': { streetAddress: 'Via del Piano 29', postalCode: '6926', addressLocality: 'Montagnola' },
  'schindler': { streetAddress: 'Via Cantonale 1', postalCode: '6532', addressLocality: 'Castione' },
  'abb-svizzera-sede-ticino': { streetAddress: 'Via Cantonale 32', postalCode: '6572', addressLocality: 'Quartino' },
  'abb': { streetAddress: 'Via Cantonale 32', postalCode: '6572', addressLocality: 'Quartino' },
  'ruag-ag': { streetAddress: 'Via Campagna 1', postalCode: '6517', addressLocality: 'Arbedo' },
  'post-ch-ag': { streetAddress: 'Piazza Stazione 1', postalCode: '6500', addressLocality: 'Bellinzona' },
  'postfinance-ag': { streetAddress: 'Piazza Stazione 1', postalCode: '6500', addressLocality: 'Bellinzona' },
  'ariston-group': { streetAddress: 'Via Cantonale 31', postalCode: '6930', addressLocality: 'Bedano' },
  'skyguide': { streetAddress: 'Via Aeroporto', postalCode: '6982', addressLocality: 'Agno' },
  'skyguide-sa': { streetAddress: 'Via Aeroporto', postalCode: '6982', addressLocality: 'Agno' },
  'sunrise-communications-ag': { streetAddress: 'Via Cantonale 2c', postalCode: '6928', addressLocality: 'Manno' },
  'zucchetti-switzerland-sa': { streetAddress: 'Via Dunant 7', postalCode: '6828', addressLocality: 'Balerna' },
  'goline-sa': { streetAddress: 'Via Industria 5', postalCode: '6855', addressLocality: 'Stabio' },
  'avaloq': { streetAddress: 'Via Cantonale 10', postalCode: '6900', addressLocality: 'Lugano' },
  'lidl-svizzera': { streetAddress: 'Via Industria 6', postalCode: '6593', addressLocality: 'Cadenazzo' },
  // Generic company keys used in expired job data (no region suffix)
  'coop': { streetAddress: 'Via Vedeggio 4', postalCode: '6805', addressLocality: 'Mezzovico' },
  'galenica': { streetAddress: 'Untermattweg 8', postalCode: '3027', addressLocality: 'Bern' },
  'fnz': { streetAddress: 'Via Cantonale 19', postalCode: '6900', addressLocality: 'Lugano' },
  'fust': { streetAddress: 'Zürcherstrasse 22', postalCode: '9246', addressLocality: 'Niederbüren' },
};

/**
 * City-level fallback addresses per known Ticino/Grigioni locality.
 * Used when a company has no HQ entry and the job lacks a valid
 * streetAddress — guarantees `streetAddress` is always present.
 */
export const CITY_FALLBACK_ADDRESSES: Record<string, CompanyHqAddress> = {
  'lugano': { streetAddress: 'Piazza Riforma 1', postalCode: '6900', addressLocality: 'Lugano' },
  'mendrisio': { streetAddress: 'Via Luigi Benteler 1', postalCode: '6850', addressLocality: 'Mendrisio' },
  'chiasso': { streetAddress: 'Corso San Gottardo 84', postalCode: '6830', addressLocality: 'Chiasso' },
  'stabio': { streetAddress: 'Via Industria 1', postalCode: '6855', addressLocality: 'Stabio' },
  'bellinzona': { streetAddress: 'Piazza Governo', postalCode: '6500', addressLocality: 'Bellinzona' },
  'locarno': { streetAddress: 'Piazza Grande 18', postalCode: '6600', addressLocality: 'Locarno' },
  'ticino': { streetAddress: 'Piazza Governo', postalCode: '6500', addressLocality: 'Bellinzona' },
};

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
  return { streetAddress: 'Piazza Governo', postalCode: '6500', addressLocality: city || 'Bellinzona' };
}
