/**
 * Central location configuration for all job crawlers.
 *
 * This module is the SINGLE SOURCE OF TRUTH for:
 * - Which cantons to target (TARGET_CANTONS)
 * - All 26 Swiss canton codes and their names/aliases
 * - Company HQ defaults for Cat-C crawlers
 *
 * To expand crawling to all of Switzerland, change TARGET_CANTONS.
 */

// ─── THE SWITCH ─────────────────────────────────────────────────────────────
// Change this array to expand crawling scope.
// Today: only TI + GR. Tomorrow: all 26 cantons.
export const TARGET_CANTONS = ['TI', 'GR', 'VS'];

// ─── ALL 26 SWISS CANTONS ──────────────────────────────────────────────────
// Each canton has: code, names (all official languages + common aliases),
// and static tokens for location matching.
export const SWISS_CANTONS = {
  AG: { code: 'AG', names: ['aargau', 'argovie', 'argovia', 'aarau', 'baden', 'wettingen', 'brugg', 'lenzburg'] },
  AI: { code: 'AI', names: ['appenzell innerrhoden', 'appenzell rhodes-intérieures', 'appenzello interno', 'appenzell'] },
  AR: { code: 'AR', names: ['appenzell ausserrhoden', 'appenzell rhodes-extérieures', 'appenzello esterno', 'herisau', 'teufen'] },
  BE: { code: 'BE', names: ['bern', 'berne', 'berna', 'thun', 'biel', 'bienne', 'burgdorf', 'langenthal', 'köniz', 'ostermundigen', 'spiez', 'interlaken', 'münsingen'] },
  BL: { code: 'BL', names: ['basel-landschaft', 'bâle-campagne', 'basilea campagna', 'liestal', 'allschwil', 'reinach', 'muttenz', 'pratteln', 'binningen'] },
  BS: { code: 'BS', names: ['basel-stadt', 'bâle-ville', 'basilea città', 'basel', 'bâle', 'basilea'] },
  FR: { code: 'FR', names: ['fribourg', 'freiburg', 'friborgo', 'friburgo', 'bulle', 'murten', 'morat'] },
  GE: { code: 'GE', names: ['genève', 'geneva', 'genf', 'ginevra', 'carouge', 'vernier', 'lancy', 'meyrin', 'onex'] },
  GL: { code: 'GL', names: ['glarus', 'glaris', 'glarona'] },
  GR: {
    code: 'GR',
    names: [
      'graubünden', 'graubunden', 'grisons', 'grigioni', 'grischun',
      'engadina', 'engadin', 'mesolcina', 'calanca',
    ],
  },
  JU: { code: 'JU', names: ['jura', 'giura', 'delémont', 'delemont', 'porrentruy'] },
  LU: { code: 'LU', names: ['luzern', 'lucerne', 'lucerna', 'emmen', 'kriens', 'horw', 'sursee'] },
  NE: { code: 'NE', names: ['neuchâtel', 'neuchatel', 'neuenburg', 'la chaux-de-fonds'] },
  NW: { code: 'NW', names: ['nidwalden', 'nidwald', 'nidvaldo', 'stans'] },
  OW: { code: 'OW', names: ['obwalden', 'obwald', 'obvaldo', 'sarnen'] },
  SG: { code: 'SG', names: ['st. gallen', 'st gallen', 'saint-gall', 'san gallo', 'sankt gallen', 'st-gallen', 'rapperswil', 'buchs', 'gossau', 'wil'] },
  SH: { code: 'SH', names: ['schaffhausen', 'schaffhouse', 'sciaffusa'] },
  SO: { code: 'SO', names: ['solothurn', 'soleure', 'soletta', 'olten', 'grenchen'] },
  SZ: { code: 'SZ', names: ['schwyz', 'svitto', 'einsiedeln'] },
  TG: { code: 'TG', names: ['thurgau', 'thurgovie', 'turgovia', 'frauenfeld', 'kreuzlingen', 'weinfelden', 'amriswil'] },
  TI: {
    code: 'TI',
    names: [
      'ticino', 'tessin',
      'cantone ticino', 'canton ticino', 'canton tessin',
      'mendrisiotto', 'sopraceneri', 'sottoceneri',
      'leventina', 'vallemaggia', 'svizzera italiana',
    ],
  },
  UR: { code: 'UR', names: ['uri', 'altdorf'] },
  VD: { code: 'VD', names: ['vaud', 'waadt', 'lausanne', 'montreux', 'vevey', 'nyon', 'morges', 'renens', 'yverdon', 'yverdon-les-bains'] },
  VS: { code: 'VS', names: ['valais', 'wallis', 'vallese', 'sion', 'sitten', 'brig', 'visp', 'martigny', 'monthey', 'zermatt', 'sierre', 'naters', 'crans-montana', 'leukerbad', 'saas-fee', 'verbier'] },
  ZG: { code: 'ZG', names: ['zug', 'zoug', 'zugo', 'baar', 'cham'] },
  ZH: { code: 'ZH', names: ['zürich', 'zurich', 'zuerich', 'zurigo', 'winterthur', 'uster', 'dübendorf', 'kloten', 'wetzikon', 'dietikon', 'opfikon', 'spreitenbach'] },
};

export const ALL_CANTON_CODES = Object.keys(SWISS_CANTONS);

/**
 * Check if a canton code is in the current target scope.
 */
export function isTargetCanton(cantonCode = '') {
  return TARGET_CANTONS.includes(String(cantonCode).toUpperCase().trim());
}

/**
 * Normalize a free-text canton name to its 2-letter code.
 * Searches ALL 26 cantons (not just target cantons).
 * Returns '' if not recognized.
 */
export function normalizeAnyCantonCode(raw = '') {
  const lower = String(raw || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').trim();
  if (!lower) return '';
  // Direct 2-letter code match
  const upper = lower.toUpperCase();
  if (SWISS_CANTONS[upper]) return upper;
  // Search names/aliases
  for (const [code, canton] of Object.entries(SWISS_CANTONS)) {
    if (canton.names.some((name) => name === lower || lower === name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) {
      return code;
    }
  }
  return '';
}

// ─── COMPANY HQ REGISTRY ───────────────────────────────────────────────────
// Default location for Cat-C crawlers (single-location companies).
// Used by crawlers via getCompanyDefaults(slug).
export const COMPANY_HQ = {
  // ── TI companies ──
  'a-plus-plus-group':            { city: 'Massagno',           canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'ail':                          { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'aldi-suisse':                  { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'artisa':                       { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'banca-sempione':               { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'bancastato':                   { city: 'Bellinzona',         canton: 'TI', postalCode: '6500', addressRegion: 'TI' },
  'bosch':                        { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'bps-suisse':                   { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'cambiavalute':                 { city: 'Chiasso',            canton: 'TI', postalCode: '6830', addressRegion: 'TI' },
  'casale':                       { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'caseificio-gottardo':          { city: 'Airolo',             canton: 'TI', postalCode: '6780', addressRegion: 'TI' },
  'centiel':                      { city: 'Cadro',              canton: 'TI', postalCode: '6965', addressRegion: 'TI' },
  'convit':                       { city: 'Massagno',           canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'cerbios-pharma':               { city: 'Barbengo',           canton: 'TI', postalCode: '6917', addressRegion: 'TI' },
  'citta-di-bellinzona':          { city: 'Bellinzona',         canton: 'TI', postalCode: '6500', addressRegion: 'TI' },
  'citta-di-locarno':             { city: 'Locarno',            canton: 'TI', postalCode: '6600', addressRegion: 'TI' },
  'citta-di-lugano':              { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'corner':                       { city: 'Lugano',             canton: 'TI', postalCode: '6901', addressRegion: 'TI' },
  'csc-costruzioni':              { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'damiani':                      { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'delvitech':                    { city: 'Bioggio',            canton: 'TI', postalCode: '6934', addressRegion: 'TI' },
  'dot-life':                     { city: 'Paradiso',           canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'engelvoelkers':                { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'eoc':                          { city: 'Bellinzona',         canton: 'TI', postalCode: '6500', addressRegion: 'TI' },
  'fart':                         { city: 'Locarno',            canton: 'TI', postalCode: '6601', addressRegion: 'TI' },
  'goline':                       { city: 'Stabio',             canton: 'TI', postalCode: '6934', addressRegion: 'TI' },
  'has-healthcare':               { city: 'Biasca',             canton: 'TI', postalCode: '6710', addressRegion: 'TI' },
  'helsinn':                      { city: 'Lugano',             canton: 'TI', postalCode: '6912', addressRegion: 'TI' },
  'julius-baer':                  { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'lafonte':                      { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'lastminute':                   { city: 'Chiasso',            canton: 'TI', postalCode: '6830', addressRegion: 'TI' },
  'linnea':                       { city: 'Riazzino',           canton: 'TI', postalCode: '6595', addressRegion: 'TI' },
  'lis':                          { city: 'Pregassona',         canton: 'TI', postalCode: '6963', addressRegion: 'TI' },
  'livingcircle':                 { city: 'Ascona',             canton: 'TI', postalCode: '6612', addressRegion: 'TI' },
  'lwphr':                        { city: 'Manno',              canton: 'TI', postalCode: '6928', addressRegion: 'TI' },
  'medacta':                      { city: 'Castel San Pietro',  canton: 'TI', postalCode: '6874', addressRegion: 'TI' },
  'mendrisio':                    { city: 'Mendrisio',          canton: 'TI', postalCode: '6850', addressRegion: 'TI' },
  'otis':                         { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'oscam':                        { city: 'Caslano',            canton: 'TI', postalCode: '6987', addressRegion: 'TI' },
  'pkb-private-bank':             { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'prada':                        { city: 'Mendrisio',          canton: 'TI', postalCode: '6850', addressRegion: 'TI' },
  'raiffeisen-vc':                { city: 'Cadempino',          canton: 'TI', postalCode: '6814', addressRegion: 'TI' },
  'rapelli':                      { city: 'Stabio',             canton: 'TI', postalCode: '6855', addressRegion: 'TI' },
  'rivopharm':                    { city: 'Manno',              canton: 'TI', postalCode: '6928', addressRegion: 'TI' },
  'sintetica':                    { city: 'Mendrisio',          canton: 'TI', postalCode: '6850', addressRegion: 'TI' },
  'supsi':                        { city: 'Manno',              canton: 'TI', postalCode: '6928', addressRegion: 'TI' },
  'tarchini-group':               { city: 'Lumino',             canton: 'TI', postalCode: '6533', addressRegion: 'TI' },
  'tich':                         { city: 'Bellinzona',         canton: 'TI', postalCode: '6501', addressRegion: 'TI' },
  'tinext':                       { city: 'Manno',              canton: 'TI', postalCode: '6928', addressRegion: 'TI' },
  'tpl-lugano':                   { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'usi':                          { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'vir-biotechnology':            { city: 'Bellinzona',         canton: 'TI', postalCode: '6500', addressRegion: 'TI' },
  // ── GR companies ──
  'cedes':                        { city: 'Landquart',          canton: 'GR', postalCode: '7302', addressRegion: 'GR' },
  'davos-klosters-bergbahnen':    { city: 'Davos',              canton: 'GR', postalCode: '7270', addressRegion: 'GR' },
  'ems-chemie':                   { city: 'Domat/Ems',          canton: 'GR', postalCode: '7013', addressRegion: 'GR' },
  'ferrovia-retica':              { city: 'Chur',               canton: 'GR', postalCode: '7000', addressRegion: 'GR' },
  'grace':                        { city: 'St. Moritz',         canton: 'GR', postalCode: '7500', addressRegion: 'GR' },
  'kronenhof':                    { city: 'Pontresina',         canton: 'GR', postalCode: '7504', addressRegion: 'GR' },
  'ksgr':                         { city: 'Chur',               canton: 'GR', postalCode: '7000', addressRegion: 'GR' },
  'stadt-chur':                   { city: 'Chur',               canton: 'GR', postalCode: '7000', addressRegion: 'GR' },
  // ── Aliases (crawler COMPANY_KEY → canonical config slug) ──
  'a-group':                      { city: 'Massagno',           canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'ail-lugano':                   { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'artisa-group':                 { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'eoc-ente-ospedaliero-cantonale': { city: 'Bellinzona',       canton: 'TI', postalCode: '6500', addressRegion: 'TI' },
  'grace-la-margna':              { city: 'St. Moritz',         canton: 'GR', postalCode: '7500', addressRegion: 'GR' },
  'grand-hotel-kronenhof':        { city: 'Pontresina',         canton: 'GR', postalCode: '7504', addressRegion: 'GR' },
  'kantonsspital-graubuenden-ksgr': { city: 'Chur',             canton: 'GR', postalCode: '7000', addressRegion: 'GR' },
  'la-fonte':                     { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  // ── Valais / Wallis (VS) — major employers ──
  'lonza':                        { city: 'Visp',               canton: 'VS', postalCode: '3930', addressRegion: 'VS' },
  'hopital-du-valais':            { city: 'Sion',               canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
  'etat-du-valais':               { city: 'Sion',               canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
  'groupe-mutuel':                { city: 'Martigny',            canton: 'VS', postalCode: '1920', addressRegion: 'VS' },
  'hes-so-valais':                { city: 'Sion',               canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
  'novelis':                      { city: 'Sierre',             canton: 'VS', postalCode: '3960', addressRegion: 'VS' },
  'commune-de-sion':              { city: 'Sion',               canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
  'clinique-de-valere':           { city: 'Sion',               canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
  'cimo-sa':                      { city: 'Monthey',            canton: 'VS', postalCode: '1870', addressRegion: 'VS' },
};

/**
 * Get HQ defaults for a company by crawler slug.
 * Returns { city, canton, postalCode, addressRegion } or null.
 */
export function getCompanyDefaults(slug = '') {
  return COMPANY_HQ[slug] || null;
}

// ─── PROSPECTIVE.CH REGION IDS ─────────────────────────────────────────────
// Per-platform canton-to-regionId mapping for Prospective.ch crawlers.
// Canonical source: data/platform-region-ids.json (maintained manually + discovery script).
// This inline copy is kept for backward compatibility and fast access.
export const PROSPECTIVE_REGION_IDS = {
  // medium 1000103 (Coop, Fust) — attribute 30 = canton
  'm1000103': { TI: '1024522', GR: '1024512' },
  // medium 1000624 (Confederazione, VTG) — attribute = region
  // Romandie macro-region covers VS+VD+GE+NE+FR+JU — needs post-filtering
  'm1000624': { TI: '1083341', GR_OSTSCHWEIZ: '1083334', VS_ROMANDIE: '1083337' },
  // CC 2193 (AXA) — filter_20 = region
  'cc2193': { TI: '68794', GR_OSTSCHWEIZ: '68792' },
  // CC 1001859 (Volg) — filter_20 = region
  'cc1001859': { TI: '1164274', GR: '1164264', VS: '1164278' },
};

/**
 * Get Prospective.ch region IDs for target cantons on a given platform.
 * @param {string} platformKey - e.g. 'm1000103', 'cc2193'
 * @returns {Array<{canton: string, regionId: string}>}
 */
export function getProspectiveRegionIds(platformKey) {
  const mapping = PROSPECTIVE_REGION_IDS[platformKey];
  if (!mapping) return [];
  return Object.entries(mapping)
    .filter(([canton]) => TARGET_CANTONS.some((tc) => canton.startsWith(tc)))
    .map(([canton, regionId]) => ({ canton, regionId }));
}
