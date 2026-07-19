/**
 * Static border-crossing data used by the scheduled traffic collector.
 * Mirrors data/borderCrossings.ts (closed crossings excluded) so that
 * this file can be imported by both trafficSchedulerCore.js and unit tests
 * without pulling in server-side dependencies (firebase-admin).
 */

/**
 * Converts a crossing name to a URL-safe slug.
 * Must stay in sync with slugifyCrossingName() in TrafficAlerts.tsx.
 *
 * @param {string} name
 * @returns {string}
 */
export function slugifyCrossingName(name) {
 return name
 .normalize('NFKD')
 .replace(/[\u0300-\u036f]/g, '')
 .replace(/\([^)]*\)/g, '')
 .replace(/[^a-zA-Z0-9]+/g, '-')
 .replace(/-+/g, '-')
 .replace(/^-|-$/g, '')
 .toLowerCase();
}

/**
 * Border crossings tracked by the live TomTom/HERE wait-time collector.
 * Hand-kept mirror of data/borderCrossings.ts — NOT generated or imported
 * from it (this file must stay importable without firebase-admin/server-side
 * deps, see file header). Currently Italy ↔ Ticino only; entries here are a
 * subset of data/borderCrossings.ts with `trafficLevel: 'closed'` crossings
 * removed (the scheduler has nothing live to poll for a permanently-closed
 * crossing).
 *
 * Adding a new crossing (any country/canton — this collector doesn't care,
 * see below): append one object with EXACTLY these 3 fields, nothing else:
 *   { name: '<crossing name — must match data/borderCrossings.ts name field
 *            byte-for-byte, it's the join key via slugifyCrossingName()>',
 *     lat: <number>, lng: <number> }
 * Do NOT add `country`/`canton`/`foreignSide`/etc from the richer
 * data/borderCrossings.ts shape — this collector only ever geocodes and
 * displays a name, so those fields would be dead weight here. Do NOT add a
 * crossing whose data/borderCrossings.ts `trafficLevel` is `'closed'`.
 *
 * @type {Array<{name: string, lat: number, lng: number}>}
 */
export const BORDER_CROSSINGS = [
 // Como – Ticino
 { name: 'Chiasso Centro (Ponte Chiasso)', lat: 45.8326, lng: 9.0340 },
 { name: 'Chiasso-Brogeda', lat: 45.8409, lng: 9.0376 },
 { name: 'Chiasso-Strada', lat: 45.8332, lng: 9.0374 },
 { name: 'Maslianico-Pizzamiglio', lat: 45.8438, lng: 9.0386 },
 { name: 'Bizzarone-Novazzano', lat: 45.8401, lng: 8.9593 },
 { name: 'Ronago-Novazzano', lat: 45.8362, lng: 8.9830 },
 { name: 'Crociale dei Mulini', lat: 45.8340, lng: 8.9939 },
 { name: 'Drezzo-Pedrinate', lat: 45.8206, lng: 9.0031 },
 { name: "Lanzo d'Intelvi-Arogno", lat: 45.9624, lng: 9.0091 },
 { name: "Campione d'Italia-Bissone", lat: 45.9618, lng: 8.9686 },
 { name: 'Oria-Gandria', lat: 46.0168, lng: 9.0223 },
 // Varese – Ticino
 { name: 'Gaggiolo (Cantello-Stabio)', lat: 45.8411, lng: 8.9134 },
 { name: 'San Pietro (Clivio-Stabio)', lat: 45.8595, lng: 8.9321 },
 { name: 'Clivio-Ligornetto', lat: 45.8638, lng: 8.9395 },
 { name: 'Saltrio-Arzo', lat: 45.8740, lng: 8.9336 },
 { name: 'Ponte Tresa', lat: 45.9670, lng: 8.8589 },
 { name: 'Porto Ceresio-Brusino', lat: 45.9135, lng: 8.9042 },
 { name: 'Cremenaga-Ponte Cremenaga', lat: 45.9907, lng: 8.8075 },
 { name: 'Luino-Fornasette', lat: 45.9931, lng: 8.7878 },
 { name: 'Zenna-Dirinella', lat: 46.1040, lng: 8.7579 },
 { name: 'Biegno-Indemini', lat: 46.0955, lng: 8.8164 },
 { name: 'Dumenza-Cassinone', lat: 46.0052, lng: 8.7921 },
 // Verbania – Ticino / Vallese
 { name: 'Piaggio Valmara (Cannobio-Brissago)', lat: 46.0905, lng: 8.7240 },
 { name: 'Camedo (Re-Centovalli)', lat: 46.1592, lng: 8.6312 },
 { name: 'Sempione (Iselle-Gondo)', lat: 46.2422, lng: 8.1430 },
 // France — Genève / Vaud / Neuchâtel / Jura / Valais
 { name: 'Bardonnex', lat: 46.1495357, lng: 6.0960713 },
 { name: 'Ferney-Voltaire / Grand-Saconnex', lat: 46.2500450, lng: 6.1190510 },
 { name: 'Meyrin / CERN', lat: 46.2346644, lng: 6.0504576 },
 { name: 'Thônex-Vallard (Autoroute Blanche)', lat: 46.1888609, lng: 6.2021449 },
 { name: 'Moillesulaz', lat: 46.1922031, lng: 6.2062853 },
 { name: 'Perly (Perly-Certoux)', lat: 46.1525678, lng: 6.0905238 },
 { name: 'Anières', lat: 46.2685544, lng: 6.2382308 },
 { name: 'Sauverny', lat: 46.3113849, lng: 6.1204164 },
 { name: 'Hermance', lat: 46.3021881, lng: 6.2437346 },
 { name: 'Landecy', lat: 46.1446362, lng: 6.1295124 },
 { name: 'Vallorbe-Jougne (La Ferrière)', lat: 46.7120, lng: 6.3792 },
 { name: 'La Cure-Les Rousses', lat: 46.4667, lng: 6.0667 },
 { name: "L'Auberson-Les Fourgs", lat: 46.8350, lng: 6.4061 },
 { name: "Le Brassus-Bois-d'Amont", lat: 46.5817, lng: 6.2114 },
 { name: 'Crassier-Divonne', lat: 46.3667, lng: 6.1667 },
 { name: 'Chavannes-de-Bogis-Divonne', lat: 46.3500, lng: 6.1667 },
 { name: 'Les Verrières', lat: 46.9056, lng: 6.4819 },
 { name: 'Col-des-Roches (Col France)', lat: 47.0569, lng: 6.7486 },
 { name: 'Biaufond', lat: 47.1686, lng: 6.8267 },
 { name: 'Boncourt-Delle (A16)', lat: 47.5000, lng: 7.0000 },
 { name: 'Fahy-Abbévillers', lat: 47.4195, lng: 6.9514 },
 { name: 'Goumois', lat: 47.2616, lng: 6.9511 },
 { name: 'Le Châtelard-Vallorcine', lat: 46.0621, lng: 6.9587 },
 { name: 'Saint-Gingolph', lat: 46.3934, lng: 6.8043 },
 { name: 'Morgins-Châtel (Pas de Morgins)', lat: 46.2395, lng: 6.8519 },
];
