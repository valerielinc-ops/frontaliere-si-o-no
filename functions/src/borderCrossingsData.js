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
 * Active border crossings between Italy and Switzerland (Lombardia → Ticino).
 * Sourced from data/borderCrossings.ts with `trafficLevel: 'closed'` entries removed.
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
];
