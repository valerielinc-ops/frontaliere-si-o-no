/**
 * Static border-crossing data used by the scheduled traffic collector.
 * Mirrors data/borderCrossings.ts (closed crossings excluded) so that
 * this file can be imported by both trafficSchedulerCore.js and unit tests
 * without pulling in server-side dependencies (firebase-admin).
 */

/**
 * Explicit per-name overrides for crossings whose display name collides with
 * another crossing's slug under the general rule below (issue #4890): the
 * general rule strips parenthetical content, and 'Widnau-Lustenau
 * (Wiesenrain)' / 'Widnau-Lustenau (Schmitterbrücke)' both reduce to
 * "widnau-lustenau". 'Wiesenrain' keeps the unchanged slug (it is the first
 * of the two in this file / data/borderCrossings.ts); 'Schmitterbrücke' gets
 * this override instead. Neither crossing has a public /traffico-dogane/
 * page, so no redirect is needed — do NOT change the general rule itself, 5
 * other crossings (incl. the primary Chiasso Centro one) have indexed URLs
 * that depend on parens being stripped.
 *
 * Mirror of the override in services/borderCrossingSlug.ts — keep both in
 * sync by hand (see file header). Anti-collision regression coverage lives
 * in tests/border-crossing-slug-collision.test.ts.
 *
 * @type {Record<string, string>}
 */
const CROSSING_SLUG_OVERRIDES = {
 'Widnau-Lustenau (Schmitterbrücke)': 'widnau-lustenau-schmitterbrucke',
};

/**
 * Converts a crossing name to a URL-safe slug.
 * Must stay in sync with slugifyCrossingName() in services/borderCrossingSlug.ts
 * (the app-layer copy — cannot share a module across the bundler boundary).
 *
 * @param {string} name
 * @returns {string}
 */
export function slugifyCrossingName(name) {
 const override = CROSSING_SLUG_OVERRIDES[name];
 if (override) {
 return override;
 }
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
 // Austria e Liechtenstein — San Gallo/Grigioni (2026-07)
 { name: 'Rheineck-Gaißau', lat: 47.4655, lng: 9.5989 },
 { name: 'St. Margrethen-Höchst', lat: 47.4482, lng: 9.6571 },
 { name: 'Au-Lustenau', lat: 47.4314, lng: 9.6465 },
 { name: 'Widnau-Lustenau (Wiesenrain)', lat: 47.4087, lng: 9.6509 },
 { name: 'Widnau-Lustenau (Schmitterbrücke)', lat: 47.3942, lng: 9.6691 },
 { name: 'Diepoldsau-Hohenems', lat: 47.3908, lng: 9.6445 },
 { name: 'Kriessern-Mäder', lat: 47.3653, lng: 9.6072 },
 { name: 'Montlingen-Koblach', lat: 47.3345, lng: 9.5892 },
 { name: 'Rüthi-Meiningen', lat: 47.2956, lng: 9.5372 },
 { name: 'Trübbach-Balzers', lat: 47.0729, lng: 9.4819 },
 { name: 'Sevelen-Vaduz', lat: 47.1206, lng: 9.4869 },
 { name: 'Buchs (SG)-Schaan', lat: 47.1673, lng: 9.4797 },
 { name: 'Haag-Bendern', lat: 47.2101, lng: 9.4994 },
 { name: 'Salez-Ruggell', lat: 47.2415, lng: 9.5023 },
 { name: 'St. Luzisteig (Fläsch-Balzers)', lat: 47.0298, lng: 9.5284 },
 { name: 'Martina-Nauders (Finstermünz)', lat: 46.8848, lng: 10.4633 },
 { name: 'Samnaun-Spiss', lat: 46.9430, lng: 10.3586 },
  // GERMANIA — Basilea/Argovia/Zurigo/Sciaffusa/Turgovia (2026-07)
  { name: 'Basel – Weil am Rhein, Hiltalingerstrasse', lat: 47.588975, lng: 7.593195 },
  { name: 'Basel – Weil am Rhein, Autostrada A2/A5', lat: 47.586075, lng: 7.60216 },
  { name: 'Basel – Weil am Rhein, Freiburgerstrasse', lat: 47.581244, lng: 7.604567 },
  { name: 'Riehen – Weil am Rhein', lat: 47.592191, lng: 7.642481 },
  { name: 'Riehen – Lörrach-Stetten', lat: 47.595273, lng: 7.655568 },
  { name: 'Inzlingen – Riehen', lat: 47.585541, lng: 7.672023 },
  { name: 'Grenzach-Wyhlen – Riehen', lat: 47.562299, lng: 7.634817 },
  { name: 'Rheinfelden (Baden) – Rheinfelden AG, Autostrada A861/A3', lat: 47.5484, lng: 7.758324 },
  { name: 'Rheinfelden (Baden) – Rheinfelden AG, Alte Rheinbrücke', lat: 47.555194, lng: 7.789567 },
  { name: 'Bad Säckingen – Stein AG', lat: 47.546178, lng: 7.949297 },
  { name: 'Laufenburg (Baden) – Laufenburg AG', lat: 47.561708, lng: 8.07464 },
  { name: 'Waldshut-Tiengen – Koblenz AG', lat: 47.608532, lng: 8.233171 },
  { name: 'Küssaberg – Bad Zurzach AG', lat: 47.5861, lng: 8.302424 },
  { name: 'Hohentengen am Hochrhein – Kaiserstuhl AG', lat: 47.569927, lng: 8.419077 },
  { name: 'Hohentengen am Hochrhein – Wasterkingen', lat: 47.586694, lng: 8.465513 },
  { name: 'Klettgau – Wil ZH', lat: 47.610717, lng: 8.477893 },
  { name: 'Dettighofen – Wil ZH', lat: 47.614464, lng: 8.493431 },
  { name: 'Dettighofen – Rafz', lat: 47.634001, lng: 8.521101 },
  { name: 'Lottstetten – Rafz, Landstrasse', lat: 47.620096, lng: 8.561093 },
  { name: 'Lottstetten – Rafz, Schaffhausener Strasse', lat: 47.614015, lng: 8.570984 },
  { name: 'Lottstetten – Nack', lat: 47.602844, lng: 8.563866 },
  { name: 'Jestetten – Rheinau', lat: 47.647645, lng: 8.602846 },
  { name: 'Jestetten – Laufen-Uhwiesen, Dorfstrasse', lat: 47.665312, lng: 8.607451 },
  { name: 'Jestetten – Laufen-Uhwiesen, Grenzstrasse', lat: 47.668678, lng: 8.606188 },
  { name: 'Jestetten – Neuhausen am Rheinfall, Zollstrasse', lat: 47.669322, lng: 8.595692 },
  { name: 'Jestetten – Wilchingen', lat: 47.645763, lng: 8.531641 },
  { name: 'Klettgau – Trasadingen', lat: 47.662091, lng: 8.432037 },
  { name: 'Stühlingen – Schleitheim', lat: 47.749076, lng: 8.456429 },
  { name: 'Blumberg – Beggingen', lat: 47.78153, lng: 8.541335 },
  { name: 'Blumberg – Bargen SH, Autostrasse H4', lat: 47.80189, lng: 8.575666 },
  { name: 'Tengen – Thayngen, L188', lat: 47.786631, lng: 8.680959 },
  { name: 'Gottmadingen – Thayngen, Ebringerstrasse', lat: 47.749539, lng: 8.740788 },
  { name: 'Gottmadingen – Thayngen, Autostrada A81/A4', lat: 47.740479, lng: 8.719102 },
  { name: 'Dörflingen – Gottmadingen-Randegg', lat: 47.716861, lng: 8.735824 },
  { name: 'Ramsen-Moskau – Rielasingen-Worblingen', lat: 47.712329, lng: 8.822756 },
  { name: 'Öhningen – Stein am Rhein', lat: 47.660399, lng: 8.875839 },
  { name: 'Gailingen am Hochrhein – Dörflingen', lat: 47.695148, lng: 8.726821 },
  { name: 'Lottstetten – Rüdlingen', lat: 47.595542, lng: 8.574829 },
  { name: 'Jestetten – Neuhausen am Rheinfall, Buchweg', lat: 47.672205, lng: 8.606179 },
  { name: 'Klettgau – Wilchingen', lat: 47.657217, lng: 8.466 },
  { name: 'Eggingen – Hallau', lat: 47.696985, lng: 8.405736 },
  { name: 'Stühlingen – Hallau', lat: 47.719836, lng: 8.44029 },
  { name: 'Blumberg – Bargen SH, Alte Bargener Strasse', lat: 47.802597, lng: 8.587552 },
  { name: 'Bargen SH – Tengen', lat: 47.78709, lng: 8.616205 },
  { name: 'Merishausen – Tengen', lat: 47.780205, lng: 8.618368 },
  { name: 'Opfertshofen – Tengen', lat: 47.777035, lng: 8.648821 },
  { name: 'Tengen – Thayngen, Wiechserstrasse', lat: 47.782529, lng: 8.649898 },
  { name: 'Hilzingen – Thayngen, Schlattergasse', lat: 47.76049, lng: 8.70151 },
  { name: 'Hilzingen – Thayngen, Barzheimer Strasse', lat: 47.764794, lng: 8.711818 },
  { name: 'Dörflingen – Gailingen am Hochrhein, Hinterdorf', lat: 47.702431, lng: 8.728462 },
  { name: 'Büsingen am Hochrhein – Dörflingen, L202', lat: 47.694942, lng: 8.717411 },
  { name: 'Büsingen am Hochrhein – Dörflingen, Büsingerstrasse', lat: 47.703093, lng: 8.710149 },
  { name: 'Büsingen am Hochrhein – Dörflingen, Siedlerstrasse', lat: 47.715048, lng: 8.700513 },
  { name: 'Büsingen am Hochrhein – Schaffhausen, Gennersbrunnerstrasse', lat: 47.711228, lng: 8.669965 },
  { name: 'Büsingen am Hochrhein – Schaffhausen-Stemmer', lat: 47.697528, lng: 8.674047 },
  { name: 'Büsingen am Hochrhein – Schaffhausen, Felsgasse', lat: 47.690627, lng: 8.6589 },
  { name: 'Büsingen am Hochrhein – Schaffhausen, Vögelingässchen', lat: 47.687265, lng: 8.664058 },
  { name: 'Büsingen am Hochrhein – Schaffhausen, Rheinhaldenstrasse', lat: 47.686395, lng: 8.663779 },
  { name: 'Gailingen am Hochrhein – Ramsen SH', lat: 47.700382, lng: 8.798491 },
  { name: 'Gottmadingen – Buch SH', lat: 47.716026, lng: 8.770429 },
  { name: 'Gottmadingen – Buch-Blindenhausen SH', lat: 47.727333, lng: 8.784819 },
  { name: 'Gottmadingen – Ramsen-Hofenacker', lat: 47.731765, lng: 8.79766 },
  { name: 'Rielasingen-Worblingen – Ramsen-Hofenacker', lat: 47.731178, lng: 8.80878 },
  { name: 'Diessenhofen – Gailingen am Hochrhein', lat: 47.690801, lng: 8.750943 },
  { name: 'Konstanz – Tägerwilen, Gottlieber Strasse', lat: 47.663066, lng: 9.159937 },
  { name: 'Konstanz – Tägerwilen, Autostrada B33n/A7', lat: 47.661817, lng: 9.161366 },
  { name: 'Konstanz – Kreuzlingen', lat: 47.656157, lng: 9.169498 },
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
