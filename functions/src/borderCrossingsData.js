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
 // Grigioni e Vallese — completamento italia-svizzera (2026-07)
 { name: 'Passo dello Spluga (Montespluga)', lat: 46.5053, lng: 9.3303 },
 { name: 'Forcola di Livigno', lat: 46.4408, lng: 10.0562 },
 { name: 'Tunnel Munt La Schera (Passo del Gallo)', lat: 46.6384, lng: 10.1968 },
 { name: "Giogo di Santa Maria (Passo dell'Umbrail)", lat: 46.5416, lng: 10.4332 },
 { name: 'Campocologno-Tirano', lat: 46.2331, lng: 10.1426 },
 { name: 'Castasegna-Villa di Chiavenna', lat: 46.3331, lng: 9.5164 },
 { name: 'Traforo del Gran San Bernardo', lat: 45.8644, lng: 7.1728 },
];
