// ─── Supermarket locations near the Swiss-Italian border (within ~20km) ──────
// Sources: Google Maps, OpenStreetMap, official chain websites
// Coordinates: [lat, lng]

export interface Supermarket {
 id: string;
 name: string;
 chain: string;
 country: 'CH' | 'IT';
 lat: number;
 lng: number;
 city: string;
 address: string;
 /** Zone for convenience index grouping */
 zone: string;
}

export type SupermarketChain =
 | 'Migros' | 'Coop' | 'Aldi CH' | 'Lidl CH' | 'Denner'
 | 'Lidl IT' | 'Esselunga' | 'Carrefour' | 'Conad' | 'Eurospin' | 'Iper' | 'Tigros' | 'MD';

export const CHAIN_COLORS: Record<string, string> = {
 'Migros': '#ff6600',
 'Coop': '#e30613',
 'Aldi CH': '#0050aa',
 'Lidl CH': '#0050aa',
 'Denner': '#f5c518',
 'Lidl IT': '#0050aa',
 'Esselunga': '#d4213d',
 'Carrefour': '#004e9a',
 'Conad': '#e20714',
 'Eurospin': '#0066b3',
 'Iper': '#e4002b',
 'Tigros': '#00843d',
 'MD': '#ffd700',
};

export const CHAIN_COUNTRY: Record<string, 'CH' | 'IT'> = {
 'Migros': 'CH', 'Coop': 'CH', 'Aldi CH': 'CH', 'Lidl CH': 'CH', 'Denner': 'CH',
 'Lidl IT': 'IT', 'Esselunga': 'IT', 'Carrefour': 'IT', 'Conad': 'IT',
 'Eurospin': 'IT', 'Iper': 'IT', 'Tigros': 'IT', 'MD': 'IT',
};

// ─── Zones for convenience index ────────────────────────────────────────────
export const ZONES = [
 { id: 'chiasso-como', nameKey: 'shopping.zone.chiassoComo', label: 'Chiasso – Como' },
 { id: 'mendrisio-varese', nameKey: 'shopping.zone.mendrisioVarese', label: 'Mendrisio – Varese' },
 { id: 'lugano-ponte-tresa', nameKey: 'shopping.zone.luganoPonteTresa', label: 'Lugano – Ponte Tresa' },
 { id: 'bellinzona-locarno', nameKey: 'shopping.zone.bellinzonaLocarno', label: 'Bellinzona – Locarno' },
] as const;

// ─── Supermarket locations ──────────────────────────────────────────────────
export const SUPERMARKETS: Supermarket[] = [
 // ── Zona Chiasso–Como ──
 // CH side
 { id: 'migros-chiasso', name: 'Migros Chiasso', chain: 'Migros', country: 'CH', lat: 45.8350, lng: 9.0302, city: 'Chiasso', address: 'Via Soldini 22', zone: 'chiasso-como' },
 { id: 'coop-chiasso', name: 'Coop Chiasso', chain: 'Coop', country: 'CH', lat: 45.8356, lng: 9.0285, city: 'Chiasso', address: 'Corso San Gottardo 30', zone: 'chiasso-como' },
 { id: 'aldi-chiasso', name: 'Aldi Chiasso', chain: 'Aldi CH', country: 'CH', lat: 45.8380, lng: 9.0265, city: 'Chiasso', address: 'Via Livio 2', zone: 'chiasso-como' },
 { id: 'lidl-balerna', name: 'Lidl Balerna', chain: 'Lidl CH', country: 'CH', lat: 45.8472, lng: 9.0178, city: 'Balerna', address: 'Via Cantonale', zone: 'chiasso-como' },
 { id: 'denner-chiasso', name: 'Denner Chiasso', chain: 'Denner', country: 'CH', lat: 45.8345, lng: 9.0310, city: 'Chiasso', address: 'Via Bossi 1', zone: 'chiasso-como' },
 // IT side
 { id: 'esselunga-como', name: 'Esselunga Como', chain: 'Esselunga', country: 'IT', lat: 45.8103, lng: 9.0861, city: 'Como', address: 'Via Pasquale Paoli 24', zone: 'chiasso-como' },
 { id: 'carrefour-como', name: 'Carrefour Como', chain: 'Carrefour', country: 'IT', lat: 45.8060, lng: 9.0850, city: 'Como', address: 'Via Canturina 5', zone: 'chiasso-como' },
 { id: 'lidl-como', name: 'Lidl Como', chain: 'Lidl IT', country: 'IT', lat: 45.7968, lng: 9.0712, city: 'Como', address: 'Via Napoleona 48', zone: 'chiasso-como' },
 { id: 'eurospin-como', name: 'Eurospin Como', chain: 'Eurospin', country: 'IT', lat: 45.8020, lng: 9.0790, city: 'Como', address: 'Via Varesina 155', zone: 'chiasso-como' },
 { id: 'md-grandate', name: 'MD Grandate', chain: 'MD', country: 'IT', lat: 45.7900, lng: 9.0637, city: 'Grandate', address: 'Via per Cernobbio 15', zone: 'chiasso-como' },

 // ── Zona Mendrisio–Varese ──
 // CH side
 { id: 'migros-mendrisio', name: 'Migros Mendrisio', chain: 'Migros', country: 'CH', lat: 45.8707, lng: 8.9809, city: 'Mendrisio', address: 'Via Angelo Bentornata 2', zone: 'mendrisio-varese' },
 { id: 'coop-mendrisio', name: 'Coop Mendrisio', chain: 'Coop', country: 'CH', lat: 45.8700, lng: 8.9832, city: 'Mendrisio', address: 'Via Laveggio', zone: 'mendrisio-varese' },
 { id: 'denner-mendrisio', name: 'Denner Mendrisio', chain: 'Denner', country: 'CH', lat: 45.8695, lng: 8.9818, city: 'Mendrisio', address: 'Via G. Bentornata', zone: 'mendrisio-varese' },
 { id: 'aldi-stabio', name: 'Aldi Stabio', chain: 'Aldi CH', country: 'CH', lat: 45.8530, lng: 8.9420, city: 'Stabio', address: 'Via Cantonale 12', zone: 'mendrisio-varese' },
 // IT side
 { id: 'tigros-varese', name: 'Tigros Varese', chain: 'Tigros', country: 'IT', lat: 45.8200, lng: 8.8252, city: 'Varese', address: 'Via Gasparotto 1', zone: 'mendrisio-varese' },
 { id: 'esselunga-varese', name: 'Esselunga Varese', chain: 'Esselunga', country: 'IT', lat: 45.8143, lng: 8.8350, city: 'Varese', address: 'Via Daverio 44', zone: 'mendrisio-varese' },
 { id: 'iper-varese', name: 'Iper Varese', chain: 'Iper', country: 'IT', lat: 45.8310, lng: 8.8288, city: 'Varese', address: 'Viale Belforte 165', zone: 'mendrisio-varese' },
 { id: 'lidl-varese', name: 'Lidl Varese', chain: 'Lidl IT', country: 'IT', lat: 45.8175, lng: 8.8310, city: 'Varese', address: 'Via Sanvito Silvestro 80', zone: 'mendrisio-varese' },
 { id: 'eurospin-varese', name: 'Eurospin Varese', chain: 'Eurospin', country: 'IT', lat: 45.8098, lng: 8.8422, city: 'Varese', address: 'Via Monte Generoso 71', zone: 'mendrisio-varese' },
 { id: 'conad-luino', name: 'Conad Luino', chain: 'Conad', country: 'IT', lat: 46.0026, lng: 8.7458, city: 'Luino', address: 'Viale Dante 14', zone: 'mendrisio-varese' },

 // ── Zona Lugano–Ponte Tresa ──
 // CH side
 { id: 'migros-lugano', name: 'Migros Lugano Centro', chain: 'Migros', country: 'CH', lat: 46.0037, lng: 8.9511, city: 'Lugano', address: 'Via Pretorio 15', zone: 'lugano-ponte-tresa' },
 { id: 'coop-lugano', name: 'Coop Lugano', chain: 'Coop', country: 'CH', lat: 46.0043, lng: 8.9475, city: 'Lugano', address: 'Via Nassa 5', zone: 'lugano-ponte-tresa' },
 { id: 'migros-agno', name: 'Migros Agno', chain: 'Migros', country: 'CH', lat: 45.9970, lng: 8.9030, city: 'Agno', address: 'Via Cantonale 12', zone: 'lugano-ponte-tresa' },
 { id: 'aldi-lugano', name: 'Aldi Lugano Grancia', chain: 'Aldi CH', country: 'CH', lat: 45.9792, lng: 8.9234, city: 'Grancia', address: 'Via Cantonale 18', zone: 'lugano-ponte-tresa' },
 { id: 'lidl-lugano', name: 'Lidl Canobbio', chain: 'Lidl CH', country: 'CH', lat: 46.0180, lng: 8.9620, city: 'Canobbio', address: 'Via Roncaccio', zone: 'lugano-ponte-tresa' },
 { id: 'denner-lugano', name: 'Denner Lugano', chain: 'Denner', country: 'CH', lat: 46.0050, lng: 8.9530, city: 'Lugano', address: 'Via Pietro Peri 4', zone: 'lugano-ponte-tresa' },
 // IT side
 { id: 'conad-ponte-tresa', name: 'Conad Lavena Ponte Tresa', chain: 'Conad', country: 'IT', lat: 45.9670, lng: 8.8610, city: 'Lavena Ponte Tresa', address: 'Via Roma 25', zone: 'lugano-ponte-tresa' },
 { id: 'md-ponte-tresa', name: 'MD Lavena Ponte Tresa', chain: 'MD', country: 'IT', lat: 45.9665, lng: 8.8590, city: 'Lavena Ponte Tresa', address: 'Via IV Novembre', zone: 'lugano-ponte-tresa' },
 { id: 'tigros-marchirolo', name: 'Tigros Marchirolo', chain: 'Tigros', country: 'IT', lat: 45.9530, lng: 8.8180, city: 'Marchirolo', address: 'Via Provinciale 10', zone: 'lugano-ponte-tresa' },

 // ── Zona Bellinzona–Locarno ──
 // CH side
 { id: 'migros-bellinzona', name: 'Migros Bellinzona', chain: 'Migros', country: 'CH', lat: 46.1953, lng: 9.0187, city: 'Bellinzona', address: 'Viale Stazione 5', zone: 'bellinzona-locarno' },
 { id: 'coop-bellinzona', name: 'Coop Bellinzona', chain: 'Coop', country: 'CH', lat: 46.1945, lng: 9.0210, city: 'Bellinzona', address: 'Via San Gottardo 34', zone: 'bellinzona-locarno' },
 { id: 'aldi-bellinzona', name: 'Aldi Bellinzona', chain: 'Aldi CH', country: 'CH', lat: 46.1960, lng: 9.0150, city: 'Bellinzona', address: 'Via Tatti 5', zone: 'bellinzona-locarno' },
 { id: 'migros-locarno', name: 'Migros Locarno', chain: 'Migros', country: 'CH', lat: 46.1670, lng: 8.7978, city: 'Locarno', address: 'Piazza Grande 1', zone: 'bellinzona-locarno' },
 { id: 'coop-locarno', name: 'Coop Locarno', chain: 'Coop', country: 'CH', lat: 46.1665, lng: 8.7985, city: 'Locarno', address: 'Via F. Rusca 1', zone: 'bellinzona-locarno' },
 { id: 'denner-locarno', name: 'Denner Locarno', chain: 'Denner', country: 'CH', lat: 46.1680, lng: 8.7950, city: 'Locarno', address: 'Via della Posta 2', zone: 'bellinzona-locarno' },
 { id: 'lidl-giubiasco', name: 'Lidl Giubiasco', chain: 'Lidl CH', country: 'CH', lat: 46.1745, lng: 9.0095, city: 'Giubiasco', address: 'Via Industrie 1', zone: 'bellinzona-locarno' },
];

// ─── Convenience index per zone (IT vs CH basket cost ratio) ────────────────
// Calculated from the PRODUCTS basket in ShoppingCalculator (avg savings %)
// Higher = more convenient to shop in Italy
export interface ZoneConvenience {
 zoneId: string;
 /** Average % cheaper buying in IT vs CH for the same basket */
 savingsPercent: number;
 /** Distance to nearest IT supermarket from border (km, approx) */
 distanceToIT: number;
 /** Estimated fuel cost round trip EUR */
 fuelCostEUR: number;
 /** Net convenience: savings on €200 basket minus fuel cost */
 netConvenience: number;
 /** Traffic level: 'low' | 'medium' | 'high' */
 trafficLevel: 'low' | 'medium' | 'high';
}

export const ZONE_CONVENIENCE: ZoneConvenience[] = [
 { zoneId: 'chiasso-como', savingsPercent: 42, distanceToIT: 5, fuelCostEUR: 3.50, netConvenience: 80.50, trafficLevel: 'high' },
 { zoneId: 'mendrisio-varese', savingsPercent: 40, distanceToIT: 18, fuelCostEUR: 8.00, netConvenience: 72.00, trafficLevel: 'medium' },
 { zoneId: 'lugano-ponte-tresa', savingsPercent: 38, distanceToIT: 12, fuelCostEUR: 5.50, netConvenience: 70.50, trafficLevel: 'medium' },
 { zoneId: 'bellinzona-locarno', savingsPercent: 35, distanceToIT: 30, fuelCostEUR: 14.00, netConvenience: 56.00, trafficLevel: 'low' },
];

/** Get all unique chains present in the data */
export function getChains(): string[] {
 return [...new Set(SUPERMARKETS.map(s => s.chain))].sort();
}

/** Get supermarkets filtered by zone and/or chain */
export function filterSupermarkets(opts: { zone?: string; chain?: string; country?: 'CH' | 'IT' }): Supermarket[] {
 return SUPERMARKETS.filter(s => {
 if (opts.zone && s.zone !== opts.zone) return false;
 if (opts.chain && s.chain !== opts.chain) return false;
 if (opts.country && s.country !== opts.country) return false;
 return true;
 });
}

export const TOTAL_SUPERMARKETS = SUPERMARKETS.length;
export const TOTAL_CH = SUPERMARKETS.filter(s => s.country === 'CH').length;
export const TOTAL_IT = SUPERMARKETS.filter(s => s.country === 'IT').length;
