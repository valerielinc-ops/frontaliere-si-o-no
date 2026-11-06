/**
 * Capoluoghi cantonali nello snapshot meteo, SENZA pagine (P9f del programma
 * «sezioni articoli per cantone», D11).
 *
 * Gli hub «servizi» dei 24 gruppi cantonali (prodotti dal corpus, P10) leggono
 * `weather-snapshot.json` dal CDN tramite `refresh-canton-services-data.mjs`.
 * Lo snapshot copriva solo il cluster di confine Ticino/Insubria
 * (`data/weatherCities.ts`), quindi il blocco meteo esisteva solo per TI.
 *
 * Queste citta' entrano nello snapshot con lo stesso «consiglio» di fonti
 * (Open-Meteo + Met.no; MeteoSwiss SwissMetNet dove c'e' una stazione mappata)
 * ma NON generano pagine: `weatherCityPagesPlugin.ts` itera `WEATHER_CITIES`,
 * non questa lista, e i suoi testi sono scritti per il confine ticinese.
 * Per tenere leggero il file servito alle pagine meteo (che lo idratano), la
 * previsione oraria di queste citta' non viene salvata: bastano condizioni
 * correnti e i 7 giorni.
 *
 * `canton` e' il codice REALE del cantone (BS, BL, AI, AR …): il corpus risolve
 * i gruppi URL (BASILEA, APPENZELLO) dai membri.
 */

export interface WeatherCantonCapital {
  id: string;
  name: string;
  canton: string;
  lat: number;
  lng: number;
}

export const WEATHER_CANTON_CAPITALS: readonly WeatherCantonCapital[] = Object.freeze([
  { id: 'aarau', name: 'Aarau', canton: 'AG', lat: 47.3925, lng: 8.0444 },
  { id: 'appenzell', name: 'Appenzell', canton: 'AI', lat: 47.3302, lng: 9.4096 },
  { id: 'herisau', name: 'Herisau', canton: 'AR', lat: 47.3858, lng: 9.2792 },
  { id: 'bern', name: 'Bern', canton: 'BE', lat: 46.948, lng: 7.4474 },
  { id: 'liestal', name: 'Liestal', canton: 'BL', lat: 47.484, lng: 7.735 },
  { id: 'basel', name: 'Basel', canton: 'BS', lat: 47.5596, lng: 7.5886 },
  { id: 'fribourg', name: 'Fribourg', canton: 'FR', lat: 46.8065, lng: 7.1619 },
  { id: 'geneve', name: 'Genève', canton: 'GE', lat: 46.2044, lng: 6.1432 },
  { id: 'glarus', name: 'Glarus', canton: 'GL', lat: 47.0404, lng: 9.0672 },
  { id: 'chur', name: 'Chur', canton: 'GR', lat: 46.8508, lng: 9.532 },
  { id: 'delemont', name: 'Delémont', canton: 'JU', lat: 47.3649, lng: 7.3445 },
  { id: 'luzern', name: 'Luzern', canton: 'LU', lat: 47.0502, lng: 8.3093 },
  { id: 'neuchatel', name: 'Neuchâtel', canton: 'NE', lat: 46.99, lng: 6.9293 },
  { id: 'stans', name: 'Stans', canton: 'NW', lat: 46.958, lng: 8.366 },
  { id: 'sarnen', name: 'Sarnen', canton: 'OW', lat: 46.8961, lng: 8.2457 },
  { id: 'st-gallen', name: 'St. Gallen', canton: 'SG', lat: 47.4245, lng: 9.3767 },
  { id: 'schaffhausen', name: 'Schaffhausen', canton: 'SH', lat: 47.6973, lng: 8.6349 },
  { id: 'solothurn', name: 'Solothurn', canton: 'SO', lat: 47.2088, lng: 7.5323 },
  { id: 'schwyz', name: 'Schwyz', canton: 'SZ', lat: 47.0207, lng: 8.6541 },
  { id: 'frauenfeld', name: 'Frauenfeld', canton: 'TG', lat: 47.5536, lng: 8.8987 },
  { id: 'altdorf', name: 'Altdorf', canton: 'UR', lat: 46.8804, lng: 8.6444 },
  { id: 'lausanne', name: 'Lausanne', canton: 'VD', lat: 46.5197, lng: 6.6323 },
  { id: 'sion', name: 'Sion', canton: 'VS', lat: 46.2331, lng: 7.3606 },
  { id: 'zug', name: 'Zug', canton: 'ZG', lat: 47.1662, lng: 8.5155 },
  { id: 'zurich', name: 'Zürich', canton: 'ZH', lat: 47.3769, lng: 8.5417 },
] as const);
