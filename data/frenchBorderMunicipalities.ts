/**
 * frenchBorderMunicipalities.ts — raw candidate dataset for the per-municipality
 * FRANCE border pages (issue #4545, Genève/Vaud/Neuchâtel/Jura/Valais corridor,
 * first of the FR/DE/AT/LI rollout).
 *
 * Analogous to data/municipalities.ts for the Italian corridor: a hand-maintained
 * flat literal array, one object per line, parsed by
 * scripts/build-french-border-municipalities.mjs to derive
 * data/french-border-municipalities.json (above/below-floor split applied there,
 * NOT stored here — this file is the raw candidate list only).
 *
 * SOURCES (verified 2026-07-28, all primary/official, no paid tool)
 * -------------------------------------------------------------------------
 * - name / inseeCode / dept / lat / lng / population: geo.api.gouv.fr (official
 *   French government geocoding API, INSEE 2023 population; `centre` coordinates).
 * - distanceKm / nearestCrossing / canton: OSRM public routing server
 *   (router.project-osrm.org) — REAL road-routing distance to the nearest of the
 *   25 FR entries in data/borderCrossings.ts, NOT haversine. Deliberate
 *   methodological IMPROVEMENT over data/municipalities.ts, whose `distanceKm` is
 *   haversine-only (scripts/geocode-municipalities.mjs `estimateDistanceFromBorder`
 *   calls only `haversineKm`, no routing API — confirmed by inspection this
 *   session). Disclosed here rather than silently diverging from the Italian
 *   precedent.
 * - avgRentMonthly / rentSource / rentObs: DGALN/DHUP "Carte des loyers"
 *   (indicateurs de loyers d'annonce par commune, 2025 edition, data.gouv.fr),
 *   `loypredm2` (predicted EUR/m2) x 50m2 reference size (matches the reference
 *   apartment size implicit in data/municipalities.ts's avgRentMonthly).
 *   rentSource 'commune' = real observed listings (all 22 candidates here);
 *   'maille' = regional-mesh fallback (not needed for any candidate below).
 *
 * Regime (Geneve source-tax vs Vaud/Neuchatel/Jura/Valais declaration) is NOT
 * stored per-row — it is a pure function of `canton`
 * (scripts/build-french-border-municipalities.mjs CANTON_REGIME), so the
 * classification rule lives in exactly one place.
 */

export interface FrenchBorderMunicipalityRaw {
  name: string;
  inseeCode: string;
  dept: string;
  lat: number;
  lng: number;
  population: number;
  distanceKm: number;
  nearestCrossing: string;
  canton: string;
  avgRentMonthly: number;
  rentSource: 'commune' | 'maille';
  rentObs: number;
}

export const FRENCH_BORDER_MUNICIPALITIES: FrenchBorderMunicipalityRaw[] = [
 { name: 'Thonon-les-Bains', inseeCode: '74281', dept: '74', lat: 46.3745, lng: 6.4776, population: 37928, distanceKm: 22.7, nearestCrossing: 'Hermance', canton: 'GE', avgRentMonthly: 843, rentSource: 'commune', rentObs: 6238 },
 { name: 'Annemasse', inseeCode: '74012', dept: '74', lat: 46.189, lng: 6.2476, population: 37628, distanceKm: 4.7, nearestCrossing: 'Moillesulaz', canton: 'GE', avgRentMonthly: 1050, rentSource: 'commune', rentObs: 11387 },
 { name: 'Pontarlier', inseeCode: '25462', dept: '25', lat: 46.9167, lng: 6.3796, population: 18067, distanceKm: 15, nearestCrossing: 'L\'Auberson-Les Fourgs', canton: 'VD', avgRentMonthly: 758, rentSource: 'commune', rentObs: 4889 },
 { name: 'Saint-Julien-en-Genevois', inseeCode: '74243', dept: '74', lat: 46.1375, lng: 6.0877, population: 16222, distanceKm: 2.6, nearestCrossing: 'Perly (Perly-Certoux)', canton: 'GE', avgRentMonthly: 1093, rentSource: 'commune', rentObs: 4385 },
 { name: 'Saint-Genis-Pouilly', inseeCode: '01354', dept: '01', lat: 46.2556, lng: 6.0368, population: 14432, distanceKm: 4.2, nearestCrossing: 'Meyrin / CERN', canton: 'GE', avgRentMonthly: 1128, rentSource: 'commune', rentObs: 2468 },
 { name: 'Gex', inseeCode: '01173', dept: '01', lat: 46.3515, lng: 6.0488, population: 13627, distanceKm: 11.8, nearestCrossing: 'Sauverny', canton: 'GE', avgRentMonthly: 1059, rentSource: 'commune', rentObs: 4353 },
 { name: 'Gaillard', inseeCode: '74133', dept: '74', lat: 46.1841, lng: 6.2051, population: 11423, distanceKm: 1.6, nearestCrossing: 'Moillesulaz', canton: 'GE', avgRentMonthly: 886, rentSource: 'commune', rentObs: 1932 },
 { name: 'Divonne-les-Bains', inseeCode: '01143', dept: '01', lat: 46.3754, lng: 6.1114, population: 10464, distanceKm: 5.8, nearestCrossing: 'Crassier-Divonne', canton: 'VD', avgRentMonthly: 1392, rentSource: 'commune', rentObs: 2957 },
 { name: 'Ville-la-Grand', inseeCode: '74305', dept: '74', lat: 46.2061, lng: 6.2579, population: 9514, distanceKm: 5.4, nearestCrossing: 'Moillesulaz', canton: 'GE', avgRentMonthly: 808, rentSource: 'commune', rentObs: 1238 },
 { name: 'Prevessin-Moens', inseeCode: '01313', dept: '01', lat: 46.2594, lng: 6.0722, population: 9153, distanceKm: 4.4, nearestCrossing: 'Ferney-Voltaire / Grand-Saconnex', canton: 'GE', avgRentMonthly: 1232, rentSource: 'commune', rentObs: 1424 },
 { name: 'Reignier-Esery', inseeCode: '74220', dept: '74', lat: 46.1367, lng: 6.2646, population: 8464, distanceKm: 10, nearestCrossing: 'Thônex-Vallard (Autoroute Blanche)', canton: 'GE', avgRentMonthly: 919, rentSource: 'commune', rentObs: 1306 },
 { name: 'Publier', inseeCode: '74218', dept: '74', lat: 46.3914, lng: 6.5428, population: 7864, distanceKm: 21.3, nearestCrossing: 'Saint-Gingolph', canton: 'VS', avgRentMonthly: 893, rentSource: 'commune', rentObs: 538 },
 { name: 'Cranves-Sales', inseeCode: '74094', dept: '74', lat: 46.1979, lng: 6.3145, population: 7762, distanceKm: 19.1, nearestCrossing: 'Thônex-Vallard (Autoroute Blanche)', canton: 'GE', avgRentMonthly: 1059, rentSource: 'commune', rentObs: 371 },
 { name: 'Morteau', inseeCode: '25411', dept: '25', lat: 47.0643, lng: 6.5891, population: 6953, distanceKm: 17.9, nearestCrossing: 'Col-des-Roches (Col France)', canton: 'NE', avgRentMonthly: 800, rentSource: 'commune', rentObs: 1778 },
 { name: 'Thoiry', inseeCode: '01419', dept: '01', lat: 46.2448, lng: 5.9685, population: 6569, distanceKm: 8.3, nearestCrossing: 'Meyrin / CERN', canton: 'GE', avgRentMonthly: 1183, rentSource: 'commune', rentObs: 664 },
 { name: 'Ambilly', inseeCode: '74008', dept: '74', lat: 46.1957, lng: 6.2239, population: 6355, distanceKm: 2, nearestCrossing: 'Moillesulaz', canton: 'GE', avgRentMonthly: 1064, rentSource: 'commune', rentObs: 1821 },
 { name: 'Cessy', inseeCode: '01071', dept: '01', lat: 46.3157, lng: 6.082, population: 5832, distanceKm: 3.5, nearestCrossing: 'Sauverny', canton: 'GE', avgRentMonthly: 1039, rentSource: 'commune', rentObs: 794 },
 { name: 'Delle', inseeCode: '90033', dept: '90', lat: 47.509, lng: 6.996, population: 5623, distanceKm: 4.2, nearestCrossing: 'Boncourt-Delle (A16)', canton: 'JU', avgRentMonthly: 533, rentSource: 'commune', rentObs: 1217 },
 { name: 'Cruseilles', inseeCode: '74096', dept: '74', lat: 46.0425, lng: 6.1111, population: 5376, distanceKm: 17.4, nearestCrossing: 'Bardonnex', canton: 'GE', avgRentMonthly: 898, rentSource: 'commune', rentObs: 1204 },
 { name: 'Villers-le-Lac', inseeCode: '25321', dept: '25', lat: 47.073, lng: 6.6946, population: 5292, distanceKm: 11.2, nearestCrossing: 'Col-des-Roches (Col France)', canton: 'NE', avgRentMonthly: 773, rentSource: 'commune', rentObs: 850 },
 { name: 'Ornex', inseeCode: '01281', dept: '01', lat: 46.2779, lng: 6.0953, population: 5082, distanceKm: 4.3, nearestCrossing: 'Ferney-Voltaire / Grand-Saconnex', canton: 'GE', avgRentMonthly: 1150, rentSource: 'commune', rentObs: 759 },
 { name: 'Hauts de Bienne', inseeCode: '39368', dept: '39', lat: 46.5165, lng: 6.0002, population: 5032, distanceKm: 14.7, nearestCrossing: 'La Cure-Les Rousses', canton: 'VD', avgRentMonthly: 620, rentSource: 'commune', rentObs: 1164 },
];
