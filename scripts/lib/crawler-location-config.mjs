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
// Cathedral CH-wide: expanded to all 26 Swiss cantons (2026-05-10, P1.6).
// Brand "Frontaliere Ticino" intoccato (D1 SEO-first); per-canton URLs emit
// via canton-quorum-gate (D7) + slug-registry frozen-URL strategy (E9).
// Legacy three-canton scope was: ['TI', 'GR', 'VS'].
export const TARGET_CANTONS = ['AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE', 'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH'];

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
  'pdgr':                         { city: 'Chur',               canton: 'GR', postalCode: '7000', addressRegion: 'GR' },
  'kanton-gr':                    { city: 'Chur',               canton: 'GR', postalCode: '7000', addressRegion: 'GR' },
  'kulm-hotel':                   { city: 'St. Moritz',         canton: 'GR', postalCode: '7500', addressRegion: 'GR' },
  'weisse-arena':                 { city: 'Laax',               canton: 'GR', postalCode: '7031', addressRegion: 'GR' },
  'flury-stiftung':               { city: 'Schiers',            canton: 'GR', postalCode: '7220', addressRegion: 'GR' },
  'hochgebirgsklinik-davos':      { city: 'Davos',              canton: 'GR', postalCode: '7270', addressRegion: 'GR' },
  'badrutts-palace':              { city: 'St. Moritz',         canton: 'GR', postalCode: '7500', addressRegion: 'GR' },
  'rss-surselva':                 { city: 'Ilanz',              canton: 'GR', postalCode: '7130', addressRegion: 'GR' },
  'integra-biosciences':          { city: 'Zizers',             canton: 'GR', postalCode: '7205', addressRegion: 'GR' },
  'spital-thusis':                { city: 'Thusis',             canton: 'GR', postalCode: '7430', addressRegion: 'GR' },
  'gkb':                          { city: 'Chur',               canton: 'GR', postalCode: '7000', addressRegion: 'GR' },
  'tschuggen':                    { city: 'Arosa',              canton: 'GR', postalCode: '7050', addressRegion: 'GR' },
  'cseb':                         { city: 'Scuol',              canton: 'GR', postalCode: '7550', addressRegion: 'GR' },
  'somedia':                      { city: 'Chur',               canton: 'GR', postalCode: '7000', addressRegion: 'GR' },
  'spital-davos':                 { city: 'Davos',              canton: 'GR', postalCode: '7270', addressRegion: 'GR' },
  'fhgr':                         { city: 'Chur',               canton: 'GR', postalCode: '7000', addressRegion: 'GR' },
  'wuerth-international':         { city: 'Chur',               canton: 'GR', postalCode: '7000', addressRegion: 'GR' },
  'heineken-ch':                  { city: 'Chur',               canton: 'GR', postalCode: '7000', addressRegion: 'GR' },
  'giardino':                     { city: 'Champfèr',           canton: 'GR', postalCode: '7512', addressRegion: 'GR' },
  'gemeinde-st-moritz':           { city: 'St. Moritz',         canton: 'GR', postalCode: '7500', addressRegion: 'GR' },
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
  // ── New Valais crawlers (Apr 2026) ──
  'marriott':                     { city: 'Zermatt',            canton: 'VS', postalCode: '3920', addressRegion: 'VS' },
  'reboot-monkey':                { city: 'Visp',               canton: 'VS', postalCode: '3930', addressRegion: 'VS' },
  'arxada':                       { city: 'Visp',               canton: 'VS', postalCode: '3930', addressRegion: 'VS' },
  'ubs':                          { city: 'Sion',               canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
  'interdiscount':                { city: 'Naters',             canton: 'VS', postalCode: '3904', addressRegion: 'VS' },
  'matterhorn-gotthard-bahn':     { city: 'Brig',               canton: 'VS', postalCode: '3900', addressRegion: 'VS' },
  'swiss-life':                   { city: 'Sion',               canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
  'siegfried':                    { city: 'Evionnaz',            canton: 'VS', postalCode: '1902', addressRegion: 'VS' },
  'vaxcyte':                      { city: 'Sion',               canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
  'srg-ssr':                      { city: 'Bern',               canton: 'BE', postalCode: '3000', addressRegion: 'BE' },
  'inselspital':                  { city: 'Bern',               canton: 'BE', postalCode: '3010', addressRegion: 'BE' },
  // ── Cathedral Phase 3 hospital crawlers ──
  'usz':                          { city: 'Zürich',             canton: 'ZH', postalCode: '8091', addressRegion: 'ZH' },
  'unispital-basel':              { city: 'Basel',              canton: 'BS', postalCode: '4031', addressRegion: 'BS' },
  'kssg':                         { city: 'St. Gallen',         canton: 'SG', postalCode: '9007', addressRegion: 'SG' },
  'stadtspital-zuerich':          { city: 'Zürich',             canton: 'ZH', postalCode: '8063', addressRegion: 'ZH' },
  'luks':                         { city: 'Luzern',             canton: 'LU', postalCode: '6000', addressRegion: 'LU' },
  // ── Cathedral Phase 5 hospital crawlers (wave 2) ──
  'hirslanden':                   { city: 'Zürich',             canton: 'ZH', postalCode: '8008', addressRegion: 'ZH' },
  'spital-sts':                   { city: 'Thun',               canton: 'BE', postalCode: '3600', addressRegion: 'BE' },
  'lindenhofgruppe':              { city: 'Bern',               canton: 'BE', postalCode: '3012', addressRegion: 'BE' },
  'spital-limmattal':             { city: 'Schlieren',          canton: 'ZH', postalCode: '8952', addressRegion: 'ZH' },
  'huntsman':                     { city: 'Monthey',            canton: 'VS', postalCode: '1870', addressRegion: 'VS' },
  'fielmann':                     { city: 'Sion',               canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
  'fusalp':                       { city: 'Annecy',             canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
  'localsearch':                  { city: 'Zurich',             canton: 'ZH', postalCode: '8001', addressRegion: 'ZH' },
  'tally-weijl':                  { city: 'Basel',              canton: 'BS', postalCode: '4001', addressRegion: 'BS' },
  'transgourmet':                 { city: 'Basel',              canton: 'BS', postalCode: '4002', addressRegion: 'BS' },
  'novartis':                     { city: 'Basel',              canton: 'BS', postalCode: '4002', addressRegion: 'BS' },
  'roche':                        { city: 'Basel',              canton: 'BS', postalCode: '4070', addressRegion: 'BS' },
  'bcvs':                         { city: 'Sion',               canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
  'coopers':                      { city: 'Visp',               canton: 'VS', postalCode: '3930', addressRegion: 'VS' },
  'kone':                         { city: 'Luzern',             canton: 'LU', postalCode: '6003', addressRegion: 'LU' },
  'mobiliar':                     { city: 'Bern',               canton: 'BE', postalCode: '3001', addressRegion: 'BE' },
  'bms-building':                 { city: 'Naters',             canton: 'VS', postalCode: '3904', addressRegion: 'VS' },
  'bls':                          { city: 'Bern',               canton: 'BE', postalCode: '3001', addressRegion: 'BE' },
  'berner-montage':               { city: 'Visp',               canton: 'VS', postalCode: '3930', addressRegion: 'VS' },
  'siemens-healthineers':         { city: 'Zurich',             canton: 'ZH', postalCode: '8047', addressRegion: 'ZH' },
  'csd-engineers':                { city: 'Sion',               canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
  'fondation-domus':              { city: 'Sion',               canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
  'jumbo':                        { city: 'Dietlikon',          canton: 'ZH', postalCode: '8305', addressRegion: 'ZH' },
  'omega':                        { city: 'Biel/Bienne',        canton: 'BE', postalCode: '2502', addressRegion: 'BE' },
  'air-zermatt':                  { city: 'Raron',              canton: 'VS', postalCode: '3942', addressRegion: 'VS' },
  'engadin-tourismus':            { city: 'St. Moritz',         canton: 'GR', postalCode: '7500', addressRegion: 'GR' },
  // ── New batch: 25 crawlers (Apr 2026) ──
  'stadler-rail':                 { city: 'Bellinzona',         canton: 'TI', postalCode: '6500', addressRegion: 'TI' },
  'tether':                       { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'bitfinex':                     { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'sika':                         { city: 'Visp',               canton: 'VS', postalCode: '3930', addressRegion: 'VS' },
  'logitech':                     { city: 'Lausanne',           canton: 'VD', postalCode: '1015', addressRegion: 'VD' },
  'holcim':                       { city: 'Zug',                canton: 'ZG', postalCode: '6300', addressRegion: 'ZG' },
  'constellium':                  { city: 'Sierre',             canton: 'VS', postalCode: '3960', addressRegion: 'VS' },
  'canton-valais':                { city: 'Sion',               canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
  'zermatt-bergbahnen':           { city: 'Zermatt',            canton: 'VS', postalCode: '3920', addressRegion: 'VS' },
  'ikea':                         { city: 'Grancia',            canton: 'TI', postalCode: '6916', addressRegion: 'TI' },
  'benteler':                     { city: 'Manno',              canton: 'TI', postalCode: '6928', addressRegion: 'TI' },
  'moncucco':                     { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'bally':                        { city: 'Caslano',            canton: 'TI', postalCode: '6987', addressRegion: 'TI' },
  'mabetex':                      { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'arosa-lenzerheide':            { city: 'Arosa',              canton: 'GR', postalCode: '7050', addressRegion: 'GR' },
  'oerlikon':                     { city: 'Balzers',            canton: 'GR', postalCode: '9496', addressRegion: 'GR' },
  'riri':                         { city: 'Mendrisio',          canton: 'TI', postalCode: '6850', addressRegion: 'TI' },
  'chicco-doro':                  { city: 'Balerna',            canton: 'TI', postalCode: '6828', addressRegion: 'TI' },
  'ubp':                          { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'apg-sga':                      { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'imerys':                       { city: 'Bodio',              canton: 'TI', postalCode: '6743', addressRegion: 'TI' },
  'faulhaber':                    { city: 'Croglio',            canton: 'TI', postalCode: '6981', addressRegion: 'TI' },
  'alprose':                      { city: 'Caslano',            canton: 'TI', postalCode: '6987', addressRegion: 'TI' },
  'kudelski-nagra':               { city: 'Lugano',             canton: 'TI', postalCode: '6900', addressRegion: 'TI' },
  'franklin-university':          { city: 'Sorengo',            canton: 'TI', postalCode: '6924', addressRegion: 'TI' },
  'elettra-1938':                 { city: 'Mendrisio',          canton: 'TI', postalCode: '6850', addressRegion: 'TI' },
  'zurich-insurance':             { city: 'Zürich',             canton: 'ZH', postalCode: '8002', addressRegion: 'ZH' },
  // ── Cathedral Phase 2 Wave C Batch 2 ──
  'nestle':                       { city: 'Vevey',              canton: 'VD', postalCode: '1800', addressRegion: 'VD' },
  'migros-hq':                    { city: 'Zürich',             canton: 'ZH', postalCode: '8005', addressRegion: 'ZH' },
  'schindler':                    { city: 'Ebikon',             canton: 'LU', postalCode: '6030', addressRegion: 'LU' },
  // ── Cathedral Phase 2 Wave C Batch 3 ──
  'swiss-re':                     { city: 'Zürich',             canton: 'ZH', postalCode: '8022', addressRegion: 'ZH' },
  'eth-zurich':                   { city: 'Zürich',             canton: 'ZH', postalCode: '8092', addressRegion: 'ZH' },
  'epfl':                         { city: 'Lausanne',           canton: 'VD', postalCode: '1015', addressRegion: 'VD' },
  // ── Cathedral Phase 2 Wave C Batch 3 Wave 2 ──
  'chuv':                         { city: 'Lausanne',           canton: 'VD', postalCode: '1011', addressRegion: 'VD' },
  // ── Cathedral Phase 4 T4.1b — tier-2 marquee ──
  'sulzer':                       { city: 'Winterthur',         canton: 'ZH', postalCode: '8401', addressRegion: 'ZH' },
  'givaudan':                     { city: 'Vernier',            canton: 'GE', postalCode: '1214', addressRegion: 'GE' },
  // ── Cathedral Phase 4 T4.2 wave 1 — hospitals ──
  'ksa':                          { city: 'Aarau',              canton: 'AG', postalCode: '5001', addressRegion: 'AG' },
  'ksw':                          { city: 'Winterthur',         canton: 'ZH', postalCode: '8400', addressRegion: 'ZH' },
  'spital-thurgau':               { city: 'Münsterlingen',      canton: 'TG', postalCode: '8596', addressRegion: 'TG' },
  'solothurner-spitaeler':        { city: 'Solothurn',          canton: 'SO', postalCode: '4500', addressRegion: 'SO' },
  // ── Cathedral Phase 6 T6.5 wave 1 — tier-3 marquee (banking/luxury/shipping/industrial/insurance) ──
  'lombard-odier':                { city: 'Geneva',             canton: 'GE', postalCode: '1204', addressRegion: 'GE' },
  'richemont':                    { city: 'Bellevue',           canton: 'GE', postalCode: '1293', addressRegion: 'GE' },
  'msc-cargo':                    { city: 'Geneva',             canton: 'GE', postalCode: '1201', addressRegion: 'GE' },
  'bobst':                        { city: 'Mex',                canton: 'VD', postalCode: '1031', addressRegion: 'VD' },
  'vaudoise':                     { city: 'Lausanne',           canton: 'VD', postalCode: '1007', addressRegion: 'VD' },
  // ── Cathedral Phase 6 T6.6 wave 1 — hospitals ──
  'gzo-wetzikon':                 { city: 'Wetzikon',           canton: 'ZH', postalCode: '8620', addressRegion: 'ZH' },
  'spital-maennedorf':            { city: 'Männedorf',          canton: 'ZH', postalCode: '8708', addressRegion: 'ZH' },
  'spital-uster':                 { city: 'Uster',              canton: 'ZH', postalCode: '8610', addressRegion: 'ZH' },
  'ksb':                          { city: 'Baden',              canton: 'AG', postalCode: '5404', addressRegion: 'AG' },
  'see-spital':                   { city: 'Horgen',             canton: 'ZH', postalCode: '8810', addressRegion: 'ZH' },
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

// ─── ALIASES REQUIRED BY docs/crawler-parametrizzazione-plan.md ───────────
// The plan specifies HQ_REGISTRY + getCantonForLocation names. We expose them
// here as thin aliases over COMPANY_HQ + location→canton resolution so the
// plan's contract is satisfied without churning the existing API.

/** Alias for COMPANY_HQ — kept for naming parity with the param plan. */
export const HQ_REGISTRY = COMPANY_HQ;

/**
 * Localized human-readable name for a canton code, used by crawlers that
 * embed a region label in the job description. Replaces hardcoded ternaries
 * like `canton === 'GR' ? 'Grigioni' : 'Ticino'` (docs/crawler-parametrizzazione-plan.md).
 *
 * @param {string} cantonCode - 2-letter canton code (TI, GR, VS, …)
 * @param {'it'|'de'|'fr'|'en'} locale - output language; defaults to 'it'
 * @returns {string} canton name in the requested language, or the raw code if unknown.
 */
export function getCantonDisplayName(cantonCode = '', locale = 'it') {
  const code = String(cantonCode).toUpperCase().trim();
  const entry = SWISS_CANTONS[code];
  if (!entry) return cantonCode;

  const map = {
    TI: { it: 'Ticino', de: 'Tessin', fr: 'Tessin', en: 'Ticino' },
    GR: { it: 'Grigioni', de: 'Graubünden', fr: 'Grisons', en: 'Graubünden' },
    VS: { it: 'Vallese', de: 'Wallis', fr: 'Valais', en: 'Valais' },
    ZH: { it: 'Zurigo', de: 'Zürich', fr: 'Zurich', en: 'Zurich' },
    BE: { it: 'Berna', de: 'Bern', fr: 'Berne', en: 'Bern' },
    LU: { it: 'Lucerna', de: 'Luzern', fr: 'Lucerne', en: 'Lucerne' },
    BS: { it: 'Basilea Città', de: 'Basel-Stadt', fr: 'Bâle-Ville', en: 'Basel-Stadt' },
    GE: { it: 'Ginevra', de: 'Genf', fr: 'Genève', en: 'Geneva' },
    VD: { it: 'Vaud', de: 'Waadt', fr: 'Vaud', en: 'Vaud' },
    FR: { it: 'Friburgo', de: 'Freiburg', fr: 'Fribourg', en: 'Fribourg' },
    NE: { it: 'Neuchâtel', de: 'Neuenburg', fr: 'Neuchâtel', en: 'Neuchâtel' },
    JU: { it: 'Giura', de: 'Jura', fr: 'Jura', en: 'Jura' },
  };

  const loc = map[code];
  if (loc && loc[locale]) return loc[locale];
  // Fallback to the first canonical name from SWISS_CANTONS.
  return (entry.names[0] || code).replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Resolve a free-text location (city or canton string) to its 2-letter
 * canton code. Returns '' if nothing recognizable matched.
 *
 * Matching strategy:
 *   1. Exact / normalized match against every canton's `names` list.
 *   2. Token-substring match (location contains any canton alias).
 *
 * @param {string} rawLocation - free-text location, e.g. "Lugano, Ticino".
 * @returns {string} 2-letter canton code or ''.
 */
export function getCantonForLocation(rawLocation = '') {
  const normalized = String(rawLocation || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';

  const direct = normalizeAnyCantonCode(normalized);
  if (direct) return direct;

  for (const [code, canton] of Object.entries(SWISS_CANTONS)) {
    for (const name of canton.names) {
      const token = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (!token) continue;
      const re = new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(\\s|$)`);
      if (re.test(normalized)) return code;
    }
  }
  return '';
}
