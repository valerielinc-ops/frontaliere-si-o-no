/**
 * Border-wait page data: slug maps, path builders, route enumeration.
 *
 * F8 — The TomTom→Firestore pipeline (functions/src/trafficSchedulerCore.js,
 * scripts/collect-traffic.mjs, .github/workflows/traffic-scheduler.yml) already
 * collects per-crossing wait times every 15 min in commuter peak hours and
 * writes them to Firestore (`trafficCurrent/{slug}` + `trafficHistory/{slug}/
 * snapshots/{snapshotId}`). What was missing: static HTML pages so Google can
 * index the time-sensitive "coda dogana {valico} oggi" intent.
 *
 * URL structure (mirror of F6 fuel-daily):
 *   IT root:          /traffico-dogane/
 *   IT regional hubs: /traffico-dogane/ticino-como/ + /traffico-dogane/ticino-varese/
 *   IT per-crossing:  /traffico-dogane/{crossing}/oggi/
 *   IT month archive: /traffico-dogane/{crossing}/2026-04/  (top-5 crossings only)
 *
 *   EN: /en/border-wait/... + /today/
 *   DE: /de/wartezeit-grenze/... + /heute/
 *   FR: /fr/temps-attente-douane/... + /aujourd-hui/
 *
 * No I/O, no side effects — tests can import directly.
 */

// ── Types ─────────────────────────────────────────────────────────

export type BorderWaitLocale = 'it' | 'en' | 'de' | 'fr';

/**
 * Crossing IDs mirror `services/router.ts#ALL_BORDER_CROSSING_IDS` 1:1 —
 * kept duplicated here (not imported) to avoid a cycle with router.ts, which
 * itself imports from this module.
 *
 * New crossing → add its slug here (must equal
 * `slugifyCrossingName(crossing.name)` from `services/borderCrossingSlug.ts`,
 * the single source of truth every caller now imports). See
 * the full "Adding a new crossing" checklist above `BorderCrossingRegion`
 * below for every other map that also needs an entry.
 */
export type BorderCrossingSlug =
  | 'chiasso-centro'
  | 'chiasso-brogeda'
  | 'chiasso-strada'
  | 'maslianico-pizzamiglio'
  | 'maslianico-roggiana'
  | 'bizzarone-novazzano'
  | 'ronago-novazzano'
  | 'crociale-dei-mulini'
  | 'drezzo-pedrinate'
  | 'lanzo-d-intelvi-arogno'
  | 'campione-d-italia-bissone'
  | 'oria-gandria'
  | 'gaggiolo'
  | 'san-pietro'
  | 'clivio-ligornetto'
  | 'rodero-stabio'
  | 'saltrio-arzo'
  | 'ponte-tresa'
  | 'porto-ceresio-brusino'
  | 'cremenaga-ponte-cremenaga'
  | 'luino-fornasette'
  | 'zenna-dirinella'
  | 'biegno-indemini'
  | 'dumenza-cassinone'
  | 'camedo'
  | 'piaggio-valmara'
  // Germania (issue #4889, corridor 1 of 4)
  | 'basel-weil-am-rhein-hiltalingerstrasse'
  | 'basel-weil-am-rhein-autostrada-a2-a5'
  | 'basel-weil-am-rhein-freiburgerstrasse'
  | 'riehen-weil-am-rhein'
  | 'riehen-lorrach-stetten'
  | 'inzlingen-riehen'
  | 'grenzach-wyhlen-riehen'
  | 'rheinfelden-rheinfelden-ag-autostrada-a861-a3'
  | 'rheinfelden-rheinfelden-ag-alte-rheinbrucke'
  | 'bad-sackingen-stein-ag'
  | 'laufenburg-laufenburg-ag'
  | 'waldshut-tiengen-koblenz-ag'
  | 'kussaberg-bad-zurzach-ag'
  | 'hohentengen-am-hochrhein-kaiserstuhl-ag'
  | 'hohentengen-am-hochrhein-wasterkingen'
  | 'klettgau-wil-zh'
  | 'dettighofen-wil-zh'
  | 'dettighofen-rafz'
  | 'lottstetten-rafz-landstrasse'
  | 'lottstetten-rafz-schaffhausener-strasse'
  | 'lottstetten-nack'
  | 'jestetten-rheinau'
  | 'jestetten-laufen-uhwiesen-dorfstrasse'
  | 'jestetten-laufen-uhwiesen-grenzstrasse'
  | 'jestetten-neuhausen-am-rheinfall-zollstrasse'
  | 'jestetten-wilchingen'
  | 'klettgau-trasadingen'
  | 'stuhlingen-schleitheim'
  | 'blumberg-beggingen'
  | 'blumberg-bargen-sh-autostrasse-h4'
  | 'tengen-thayngen-l188'
  | 'gottmadingen-thayngen-ebringerstrasse'
  | 'gottmadingen-thayngen-autostrada-a81-a4'
  | 'dorflingen-gottmadingen-randegg'
  | 'ramsen-moskau-rielasingen-worblingen'
  | 'ohningen-stein-am-rhein'
  | 'gailingen-am-hochrhein-dorflingen'
  | 'lottstetten-rudlingen'
  | 'jestetten-neuhausen-am-rheinfall-buchweg'
  | 'klettgau-wilchingen'
  | 'eggingen-hallau'
  | 'stuhlingen-hallau'
  | 'blumberg-bargen-sh-alte-bargener-strasse'
  | 'bargen-sh-tengen'
  | 'merishausen-tengen'
  | 'opfertshofen-tengen'
  | 'tengen-thayngen-wiechserstrasse'
  | 'hilzingen-thayngen-schlattergasse'
  | 'hilzingen-thayngen-barzheimer-strasse'
  | 'dorflingen-gailingen-am-hochrhein-hinterdorf'
  | 'busingen-am-hochrhein-dorflingen-l202'
  | 'busingen-am-hochrhein-dorflingen-busingerstrasse'
  | 'busingen-am-hochrhein-dorflingen-siedlerstrasse'
  | 'busingen-am-hochrhein-schaffhausen-gennersbrunnerstrasse'
  | 'busingen-am-hochrhein-schaffhausen-stemmer'
  | 'busingen-am-hochrhein-schaffhausen-felsgasse'
  | 'busingen-am-hochrhein-schaffhausen-vogelingasschen'
  | 'busingen-am-hochrhein-schaffhausen-rheinhaldenstrasse'
  | 'gailingen-am-hochrhein-ramsen-sh'
  | 'gottmadingen-buch-sh'
  | 'gottmadingen-buch-blindenhausen-sh'
  | 'gottmadingen-ramsen-hofenacker'
  | 'rielasingen-worblingen-ramsen-hofenacker'
  | 'diessenhofen-gailingen-am-hochrhein'
  | 'konstanz-tagerwilen-gottlieber-strasse'
  | 'konstanz-tagerwilen-autostrada-b33n-a7'
  | 'konstanz-kreuzlingen'
  // Austria (issue #4889, corridor 2 of 4)
  | 'rheineck-gai-au'
  | 'st-margrethen-hochst'
  | 'au-lustenau'
  | 'widnau-lustenau'
  | 'diepoldsau-hohenems'
  | 'kriessern-mader'
  | 'montlingen-koblach'
  | 'ruthi-meiningen'
  | 'martina-nauders'
  | 'samnaun-spiss'
  // Liechtenstein (issue #4889, corridor 3 of 4)
  | 'trubbach-balzers'
  | 'sevelen-vaduz'
  | 'buchs-schaan'
  | 'haag-bendern'
  | 'salez-ruggell'
  | 'st-luzisteig'
  // Francia (issue #4889, corridor 4 of 4)
  | 'bardonnex'
  | 'ferney-voltaire-grand-saconnex'
  | 'meyrin-cern'
  | 'thonex-vallard'
  | 'moillesulaz'
  | 'perly'
  | 'anieres'
  | 'sauverny'
  | 'hermance'
  | 'landecy'
  | 'vallorbe-jougne'
  | 'la-cure-les-rousses'
  | 'l-auberson-les-fourgs'
  | 'le-brassus-bois-d-amont'
  | 'crassier-divonne'
  | 'chavannes-de-bogis-divonne'
  | 'les-verrieres'
  | 'col-des-roches'
  | 'biaufond'
  | 'boncourt-delle'
  | 'fahy-abbevillers'
  | 'goumois'
  | 'le-chatelard-vallorcine'
  | 'saint-gingolph'
  | 'morgins-chatel';

/**
 * Closed union of crossing "regional hub" groupings — currently one per
 * Italian province feeding the Ticino corridor ('ticino-como' groups the
 * Como-province crossings, etc.). NOT derived from `data/borderCrossings.ts`
 * — this whole file is a hand-kept mirror, kept in sync with
 * `services/router.ts#ALL_BORDER_CROSSING_IDS` (see that file's own comment)
 * and, transitively, with `data/borderCrossings.ts`.
 *
 * ── Adding a new crossing: full checklist ──────────────────────────
 *  1. If it needs a genuinely new regional hub (e.g. a first Grigioni or a
 *     France/Germany/Austria/Liechtenstein region), add a member to this
 *     union — e.g. 'grigioni-valposchiavo' or 'geneve-annemasse'.
 *  2. Add the region's display label to BORDER_REGION_DISPLAY (below).
 *  2b. Add the region's foreign country to REGION_TO_COUNTRY (below) —
 *      exhaustive on purpose, drives country-specific copy in
 *      `borderWaitPagesPlugin.ts` (extend the 'IT' | 'DE' union first if
 *      the new region's country isn't already covered).
 *  3. Add the region to BORDER_WAIT_REGIONS (below) — only if new.
 *  4. Add the crossing's slug to BorderCrossingSlug (below this block) —
 *     must equal `slugifyCrossingName(crossing.name)` from
 *     `services/borderCrossingSlug.ts` — the one implementation every
 *     caller imports (no per-file copies remain).
 *  5. Add the slug to BORDER_WAIT_CROSSINGS (below).
 *  6. Add a display-name entry to BORDER_CROSSING_DISPLAY.
 *  7. Add a region entry to CROSSING_TO_REGION.
 *  8. Add a fuel-zone entry to CROSSING_TO_FUEL_ZONE — extend the
 *     'chiasso' | 'mendrisio' | 'lugano' union first if none of the
 *     existing 3 zones is actually nearest.
 *  9. Add a weekly-city entry to CROSSING_TO_WEEKLY_CITY — same idea.
 * 10. Mirror the new slug into `services/router.ts#ALL_BORDER_CROSSING_IDS`
 *     (required 1:1 — not imported, to avoid a cycle, since this file is
 *     imported BY router.ts). Skipping this only breaks the SPA
 *     `/guida/border/{id}` deep link; the static `/traffico-dogane/...`
 *     pages below are driven entirely by this file.
 * 11. The "Count: N locales × (...)" comment on BORDER_WAIT_ROUTES further
 *     down is a manually computed illustration, not derived — update or
 *     drop the exact number when the crossing/region count changes.
 *
 * Sempione (canton VS, in data/borderCrossings.ts) is deliberately absent
 * from every map in this file — there is no static /traffico-dogane/...
 * page for it today. That's a pre-existing gap, not introduced by this
 * refactor; a future agent adding real VS coverage needs to walk this same
 * checklist for it, not assume it's already wired somewhere.
 */
export type BorderCrossingRegion =
  | 'ticino-como'
  | 'ticino-varese'
  | 'ticino-verbano'
  | 'basilea-germania'
  | 'argovia-germania'
  | 'zurigo-germania'
  | 'sciaffusa-germania'
  | 'turgovia-germania'
  | 'san-gallo-austria'
  | 'grigioni-austria'
  | 'san-gallo-liechtenstein'
  | 'grigioni-liechtenstein'
  | 'geneve-francia'
  | 'vaud-francia'
  | 'neuchatel-francia'
  | 'giura-francia'
  | 'vallese-francia';

export const BORDER_WAIT_LOCALES: readonly BorderWaitLocale[] = ['it', 'en', 'de', 'fr'] as const;

/**
 * Full crossing registry (134) — must match ALL_BORDER_CROSSING_IDS in
 * router.ts. New crossing → append its slug here too (see "Adding a new
 * crossing" checklist above BorderCrossingRegion, step 5).
 */
export const BORDER_WAIT_CROSSINGS: readonly BorderCrossingSlug[] = [
  'chiasso-centro',
  'chiasso-brogeda',
  'chiasso-strada',
  'maslianico-pizzamiglio',
  'maslianico-roggiana',
  'bizzarone-novazzano',
  'ronago-novazzano',
  'crociale-dei-mulini',
  'drezzo-pedrinate',
  'lanzo-d-intelvi-arogno',
  'campione-d-italia-bissone',
  'oria-gandria',
  'gaggiolo',
  'san-pietro',
  'clivio-ligornetto',
  'rodero-stabio',
  'saltrio-arzo',
  'ponte-tresa',
  'porto-ceresio-brusino',
  'cremenaga-ponte-cremenaga',
  'luino-fornasette',
  'zenna-dirinella',
  'biegno-indemini',
  'dumenza-cassinone',
  'camedo',
  'piaggio-valmara',
  // Germania — BS (7)
  'basel-weil-am-rhein-hiltalingerstrasse',
  'basel-weil-am-rhein-autostrada-a2-a5',
  'basel-weil-am-rhein-freiburgerstrasse',
  'riehen-weil-am-rhein',
  'riehen-lorrach-stetten',
  'inzlingen-riehen',
  'grenzach-wyhlen-riehen',
  // Germania — AG (7)
  'rheinfelden-rheinfelden-ag-autostrada-a861-a3',
  'rheinfelden-rheinfelden-ag-alte-rheinbrucke',
  'bad-sackingen-stein-ag',
  'laufenburg-laufenburg-ag',
  'waldshut-tiengen-koblenz-ag',
  'kussaberg-bad-zurzach-ag',
  'hohentengen-am-hochrhein-kaiserstuhl-ag',
  // Germania — ZH (10)
  'hohentengen-am-hochrhein-wasterkingen',
  'klettgau-wil-zh',
  'dettighofen-wil-zh',
  'dettighofen-rafz',
  'lottstetten-rafz-landstrasse',
  'lottstetten-rafz-schaffhausener-strasse',
  'lottstetten-nack',
  'jestetten-rheinau',
  'jestetten-laufen-uhwiesen-dorfstrasse',
  'jestetten-laufen-uhwiesen-grenzstrasse',
  // Germania — SH (39)
  'jestetten-neuhausen-am-rheinfall-zollstrasse',
  'jestetten-wilchingen',
  'klettgau-trasadingen',
  'stuhlingen-schleitheim',
  'blumberg-beggingen',
  'blumberg-bargen-sh-autostrasse-h4',
  'tengen-thayngen-l188',
  'gottmadingen-thayngen-ebringerstrasse',
  'gottmadingen-thayngen-autostrada-a81-a4',
  'dorflingen-gottmadingen-randegg',
  'ramsen-moskau-rielasingen-worblingen',
  'ohningen-stein-am-rhein',
  'gailingen-am-hochrhein-dorflingen',
  'lottstetten-rudlingen',
  'jestetten-neuhausen-am-rheinfall-buchweg',
  'klettgau-wilchingen',
  'eggingen-hallau',
  'stuhlingen-hallau',
  'blumberg-bargen-sh-alte-bargener-strasse',
  'bargen-sh-tengen',
  'merishausen-tengen',
  'opfertshofen-tengen',
  'tengen-thayngen-wiechserstrasse',
  'hilzingen-thayngen-schlattergasse',
  'hilzingen-thayngen-barzheimer-strasse',
  'dorflingen-gailingen-am-hochrhein-hinterdorf',
  'busingen-am-hochrhein-dorflingen-l202',
  'busingen-am-hochrhein-dorflingen-busingerstrasse',
  'busingen-am-hochrhein-dorflingen-siedlerstrasse',
  'busingen-am-hochrhein-schaffhausen-gennersbrunnerstrasse',
  'busingen-am-hochrhein-schaffhausen-stemmer',
  'busingen-am-hochrhein-schaffhausen-felsgasse',
  'busingen-am-hochrhein-schaffhausen-vogelingasschen',
  'busingen-am-hochrhein-schaffhausen-rheinhaldenstrasse',
  'gailingen-am-hochrhein-ramsen-sh',
  'gottmadingen-buch-sh',
  'gottmadingen-buch-blindenhausen-sh',
  'gottmadingen-ramsen-hofenacker',
  'rielasingen-worblingen-ramsen-hofenacker',
  // Germania — TG (4)
  'diessenhofen-gailingen-am-hochrhein',
  'konstanz-tagerwilen-gottlieber-strasse',
  'konstanz-tagerwilen-autostrada-b33n-a7',
  'konstanz-kreuzlingen',
  // Austria — SG (8)
  'rheineck-gai-au',
  'st-margrethen-hochst',
  'au-lustenau',
  'widnau-lustenau',
  'diepoldsau-hohenems',
  'kriessern-mader',
  'montlingen-koblach',
  'ruthi-meiningen',
  // Austria — GR (2)
  'martina-nauders',
  'samnaun-spiss',
  // Liechtenstein — SG (5)
  'trubbach-balzers',
  'sevelen-vaduz',
  'buchs-schaan',
  'haag-bendern',
  'salez-ruggell',
  // Liechtenstein — GR (1)
  'st-luzisteig',
  // Francia — GE (10)
  'bardonnex',
  'ferney-voltaire-grand-saconnex',
  'meyrin-cern',
  'thonex-vallard',
  'moillesulaz',
  'perly',
  'anieres',
  'sauverny',
  'hermance',
  'landecy',
  // Francia — VD (6)
  'vallorbe-jougne',
  'la-cure-les-rousses',
  'l-auberson-les-fourgs',
  'le-brassus-bois-d-amont',
  'crassier-divonne',
  'chavannes-de-bogis-divonne',
  // Francia — NE (3)
  'les-verrieres',
  'col-des-roches',
  'biaufond',
  // Francia — JU (3)
  'boncourt-delle',
  'fahy-abbevillers',
  'goumois',
  // Francia — VS (3)
  'le-chatelard-vallorcine',
  'saint-gingolph',
  'morgins-chatel',
] as const;

/** Top-5 crossings eligible for monthly archive pages (highest GSC demand). */
export const TOP_5_CROSSINGS: readonly BorderCrossingSlug[] = [
  'chiasso-brogeda',
  'chiasso-centro',
  'gaggiolo',
  'oria-gandria',
  'ponte-tresa',
] as const;

/**
 * Display names — proper nouns, same across all locales. New crossing → add
 * its name here (checklist above BorderCrossingRegion, step 6).
 */
export const BORDER_CROSSING_DISPLAY: Record<BorderCrossingSlug, string> = {
  'chiasso-centro': 'Chiasso Centro',
  'chiasso-brogeda': 'Chiasso Brogeda',
  'chiasso-strada': 'Chiasso Strada',
  'maslianico-pizzamiglio': 'Maslianico Pizzamiglio',
  'maslianico-roggiana': 'Maslianico Roggiana',
  'bizzarone-novazzano': 'Bizzarone Novazzano',
  'ronago-novazzano': 'Ronago Novazzano',
  'crociale-dei-mulini': 'Crociale dei Mulini',
  'drezzo-pedrinate': 'Drezzo Pedrinate',
  'lanzo-d-intelvi-arogno': "Lanzo d'Intelvi Arogno",
  'campione-d-italia-bissone': "Campione d'Italia Bissone",
  'oria-gandria': 'Oria Gandria',
  gaggiolo: 'Gaggiolo (Cantello-Stabio)',
  'san-pietro': 'San Pietro (Clivio-Stabio)',
  'clivio-ligornetto': 'Clivio Ligornetto',
  'rodero-stabio': 'Rodero Stabio',
  'saltrio-arzo': 'Saltrio Arzo',
  'ponte-tresa': 'Ponte Tresa',
  'porto-ceresio-brusino': 'Porto Ceresio Brusino',
  'cremenaga-ponte-cremenaga': 'Cremenaga Ponte Cremenaga',
  'luino-fornasette': 'Luino Fornasette',
  'zenna-dirinella': 'Zenna Dirinella',
  'biegno-indemini': 'Biegno Indemini',
  'dumenza-cassinone': 'Dumenza Cassinone',
  camedo: 'Camedo (Re-Centovalli)',
  'piaggio-valmara': 'Piaggio Valmara (Cannobio-Brissago)',
  'basel-weil-am-rhein-hiltalingerstrasse': 'Basel – Weil am Rhein, Hiltalingerstrasse',
  'basel-weil-am-rhein-autostrada-a2-a5': 'Basel – Weil am Rhein, Autostrada A2/A5',
  'basel-weil-am-rhein-freiburgerstrasse': 'Basel – Weil am Rhein, Freiburgerstrasse',
  'riehen-weil-am-rhein': 'Riehen – Weil am Rhein',
  'riehen-lorrach-stetten': 'Riehen – Lörrach-Stetten',
  'inzlingen-riehen': 'Inzlingen – Riehen',
  'grenzach-wyhlen-riehen': 'Grenzach-Wyhlen – Riehen',
  'rheinfelden-rheinfelden-ag-autostrada-a861-a3': 'Rheinfelden (Baden) – Rheinfelden AG, Autostrada A861/A3',
  'rheinfelden-rheinfelden-ag-alte-rheinbrucke': 'Rheinfelden (Baden) – Rheinfelden AG, Alte Rheinbrücke',
  'bad-sackingen-stein-ag': 'Bad Säckingen – Stein AG',
  'laufenburg-laufenburg-ag': 'Laufenburg (Baden) – Laufenburg AG',
  'waldshut-tiengen-koblenz-ag': 'Waldshut-Tiengen – Koblenz AG',
  'kussaberg-bad-zurzach-ag': 'Küssaberg – Bad Zurzach AG',
  'hohentengen-am-hochrhein-kaiserstuhl-ag': 'Hohentengen am Hochrhein – Kaiserstuhl AG',
  'hohentengen-am-hochrhein-wasterkingen': 'Hohentengen am Hochrhein – Wasterkingen',
  'klettgau-wil-zh': 'Klettgau – Wil ZH',
  'dettighofen-wil-zh': 'Dettighofen – Wil ZH',
  'dettighofen-rafz': 'Dettighofen – Rafz',
  'lottstetten-rafz-landstrasse': 'Lottstetten – Rafz, Landstrasse',
  'lottstetten-rafz-schaffhausener-strasse': 'Lottstetten – Rafz, Schaffhausener Strasse',
  'lottstetten-nack': 'Lottstetten – Nack',
  'jestetten-rheinau': 'Jestetten – Rheinau',
  'jestetten-laufen-uhwiesen-dorfstrasse': 'Jestetten – Laufen-Uhwiesen, Dorfstrasse',
  'jestetten-laufen-uhwiesen-grenzstrasse': 'Jestetten – Laufen-Uhwiesen, Grenzstrasse',
  'jestetten-neuhausen-am-rheinfall-zollstrasse': 'Jestetten – Neuhausen am Rheinfall, Zollstrasse',
  'jestetten-wilchingen': 'Jestetten – Wilchingen',
  'klettgau-trasadingen': 'Klettgau – Trasadingen',
  'stuhlingen-schleitheim': 'Stühlingen – Schleitheim',
  'blumberg-beggingen': 'Blumberg – Beggingen',
  'blumberg-bargen-sh-autostrasse-h4': 'Blumberg – Bargen SH, Autostrasse H4',
  'tengen-thayngen-l188': 'Tengen – Thayngen, L188',
  'gottmadingen-thayngen-ebringerstrasse': 'Gottmadingen – Thayngen, Ebringerstrasse',
  'gottmadingen-thayngen-autostrada-a81-a4': 'Gottmadingen – Thayngen, Autostrada A81/A4',
  'dorflingen-gottmadingen-randegg': 'Dörflingen – Gottmadingen-Randegg',
  'ramsen-moskau-rielasingen-worblingen': 'Ramsen-Moskau – Rielasingen-Worblingen',
  'ohningen-stein-am-rhein': 'Öhningen – Stein am Rhein',
  'gailingen-am-hochrhein-dorflingen': 'Gailingen am Hochrhein – Dörflingen',
  'lottstetten-rudlingen': 'Lottstetten – Rüdlingen',
  'jestetten-neuhausen-am-rheinfall-buchweg': 'Jestetten – Neuhausen am Rheinfall, Buchweg',
  'klettgau-wilchingen': 'Klettgau – Wilchingen',
  'eggingen-hallau': 'Eggingen – Hallau',
  'stuhlingen-hallau': 'Stühlingen – Hallau',
  'blumberg-bargen-sh-alte-bargener-strasse': 'Blumberg – Bargen SH, Alte Bargener Strasse',
  'bargen-sh-tengen': 'Bargen SH – Tengen',
  'merishausen-tengen': 'Merishausen – Tengen',
  'opfertshofen-tengen': 'Opfertshofen – Tengen',
  'tengen-thayngen-wiechserstrasse': 'Tengen – Thayngen, Wiechserstrasse',
  'hilzingen-thayngen-schlattergasse': 'Hilzingen – Thayngen, Schlattergasse',
  'hilzingen-thayngen-barzheimer-strasse': 'Hilzingen – Thayngen, Barzheimer Strasse',
  'dorflingen-gailingen-am-hochrhein-hinterdorf': 'Dörflingen – Gailingen am Hochrhein, Hinterdorf',
  'busingen-am-hochrhein-dorflingen-l202': 'Büsingen am Hochrhein – Dörflingen, L202',
  'busingen-am-hochrhein-dorflingen-busingerstrasse': 'Büsingen am Hochrhein – Dörflingen, Büsingerstrasse',
  'busingen-am-hochrhein-dorflingen-siedlerstrasse': 'Büsingen am Hochrhein – Dörflingen, Siedlerstrasse',
  'busingen-am-hochrhein-schaffhausen-gennersbrunnerstrasse': 'Büsingen am Hochrhein – Schaffhausen, Gennersbrunnerstrasse',
  'busingen-am-hochrhein-schaffhausen-stemmer': 'Büsingen am Hochrhein – Schaffhausen-Stemmer',
  'busingen-am-hochrhein-schaffhausen-felsgasse': 'Büsingen am Hochrhein – Schaffhausen, Felsgasse',
  'busingen-am-hochrhein-schaffhausen-vogelingasschen': 'Büsingen am Hochrhein – Schaffhausen, Vögelingässchen',
  'busingen-am-hochrhein-schaffhausen-rheinhaldenstrasse': 'Büsingen am Hochrhein – Schaffhausen, Rheinhaldenstrasse',
  'gailingen-am-hochrhein-ramsen-sh': 'Gailingen am Hochrhein – Ramsen SH',
  'gottmadingen-buch-sh': 'Gottmadingen – Buch SH',
  'gottmadingen-buch-blindenhausen-sh': 'Gottmadingen – Buch-Blindenhausen SH',
  'gottmadingen-ramsen-hofenacker': 'Gottmadingen – Ramsen-Hofenacker',
  'rielasingen-worblingen-ramsen-hofenacker': 'Rielasingen-Worblingen – Ramsen-Hofenacker',
  'diessenhofen-gailingen-am-hochrhein': 'Diessenhofen – Gailingen am Hochrhein',
  'konstanz-tagerwilen-gottlieber-strasse': 'Konstanz – Tägerwilen, Gottlieber Strasse',
  'konstanz-tagerwilen-autostrada-b33n-a7': 'Konstanz – Tägerwilen, Autostrada B33n/A7',
  'konstanz-kreuzlingen': 'Konstanz – Kreuzlingen',
  'rheineck-gai-au': 'Rheineck-Gaißau',
  'st-margrethen-hochst': 'St. Margrethen-Höchst',
  'au-lustenau': 'Au-Lustenau',
  'widnau-lustenau': 'Widnau-Lustenau (Wiesenrain)',
  'diepoldsau-hohenems': 'Diepoldsau-Hohenems',
  'kriessern-mader': 'Kriessern-Mäder',
  'montlingen-koblach': 'Montlingen-Koblach',
  'ruthi-meiningen': 'Rüthi-Meiningen',
  'martina-nauders': 'Martina-Nauders (Finstermünz)',
  'samnaun-spiss': 'Samnaun-Spiss',
  'trubbach-balzers': 'Trübbach-Balzers',
  'sevelen-vaduz': 'Sevelen-Vaduz',
  'buchs-schaan': 'Buchs (SG)-Schaan',
  'haag-bendern': 'Haag-Bendern',
  'salez-ruggell': 'Salez-Ruggell',
  'st-luzisteig': 'St. Luzisteig (Fläsch-Balzers)',
  bardonnex: 'Bardonnex',
  'ferney-voltaire-grand-saconnex': 'Ferney-Voltaire / Grand-Saconnex',
  'meyrin-cern': 'Meyrin / CERN',
  'thonex-vallard': 'Thônex-Vallard (Autoroute Blanche)',
  moillesulaz: 'Moillesulaz',
  perly: 'Perly (Perly-Certoux)',
  anieres: 'Anières',
  sauverny: 'Sauverny',
  hermance: 'Hermance',
  landecy: 'Landecy',
  'vallorbe-jougne': 'Vallorbe-Jougne (La Ferrière)',
  'la-cure-les-rousses': 'La Cure-Les Rousses',
  'l-auberson-les-fourgs': "L'Auberson-Les Fourgs",
  'le-brassus-bois-d-amont': "Le Brassus-Bois-d'Amont",
  'crassier-divonne': 'Crassier-Divonne',
  'chavannes-de-bogis-divonne': 'Chavannes-de-Bogis-Divonne',
  'les-verrieres': 'Les Verrières',
  'col-des-roches': 'Col-des-Roches (Col France)',
  biaufond: 'Biaufond',
  'boncourt-delle': 'Boncourt-Delle (A16)',
  'fahy-abbevillers': 'Fahy-Abbévillers',
  goumois: 'Goumois',
  'le-chatelard-vallorcine': 'Le Châtelard-Vallorcine',
  'saint-gingolph': 'Saint-Gingolph',
  'morgins-chatel': 'Morgins-Châtel (Pas de Morgins)',
};

/**
 * Regional hub grouping — by Italian province today, but the underlying
 * concept is "which regional hub page this crossing belongs to", not
 * literally "province" (a future non-Italian region keys by whatever foreign
 * administrative unit makes sense there). New crossing → add its region here
 * (checklist above BorderCrossingRegion, step 7).
 */
export const CROSSING_TO_REGION: Record<BorderCrossingSlug, BorderCrossingRegion> = {
  'chiasso-centro': 'ticino-como',
  'chiasso-brogeda': 'ticino-como',
  'chiasso-strada': 'ticino-como',
  'maslianico-pizzamiglio': 'ticino-como',
  'maslianico-roggiana': 'ticino-como',
  'bizzarone-novazzano': 'ticino-como',
  'ronago-novazzano': 'ticino-como',
  'crociale-dei-mulini': 'ticino-como',
  'drezzo-pedrinate': 'ticino-como',
  'lanzo-d-intelvi-arogno': 'ticino-como',
  'campione-d-italia-bissone': 'ticino-como',
  'oria-gandria': 'ticino-como',
  gaggiolo: 'ticino-varese',
  'san-pietro': 'ticino-varese',
  'clivio-ligornetto': 'ticino-varese',
  'rodero-stabio': 'ticino-varese',
  'saltrio-arzo': 'ticino-varese',
  'ponte-tresa': 'ticino-varese',
  'porto-ceresio-brusino': 'ticino-varese',
  'cremenaga-ponte-cremenaga': 'ticino-varese',
  'luino-fornasette': 'ticino-varese',
  'zenna-dirinella': 'ticino-varese',
  'biegno-indemini': 'ticino-varese',
  'dumenza-cassinone': 'ticino-varese',
  camedo: 'ticino-verbano',
  'piaggio-valmara': 'ticino-verbano',
  'basel-weil-am-rhein-hiltalingerstrasse': 'basilea-germania',
  'basel-weil-am-rhein-autostrada-a2-a5': 'basilea-germania',
  'basel-weil-am-rhein-freiburgerstrasse': 'basilea-germania',
  'riehen-weil-am-rhein': 'basilea-germania',
  'riehen-lorrach-stetten': 'basilea-germania',
  'inzlingen-riehen': 'basilea-germania',
  'grenzach-wyhlen-riehen': 'basilea-germania',
  'rheinfelden-rheinfelden-ag-autostrada-a861-a3': 'argovia-germania',
  'rheinfelden-rheinfelden-ag-alte-rheinbrucke': 'argovia-germania',
  'bad-sackingen-stein-ag': 'argovia-germania',
  'laufenburg-laufenburg-ag': 'argovia-germania',
  'waldshut-tiengen-koblenz-ag': 'argovia-germania',
  'kussaberg-bad-zurzach-ag': 'argovia-germania',
  'hohentengen-am-hochrhein-kaiserstuhl-ag': 'argovia-germania',
  'hohentengen-am-hochrhein-wasterkingen': 'zurigo-germania',
  'klettgau-wil-zh': 'zurigo-germania',
  'dettighofen-wil-zh': 'zurigo-germania',
  'dettighofen-rafz': 'zurigo-germania',
  'lottstetten-rafz-landstrasse': 'zurigo-germania',
  'lottstetten-rafz-schaffhausener-strasse': 'zurigo-germania',
  'lottstetten-nack': 'zurigo-germania',
  'jestetten-rheinau': 'zurigo-germania',
  'jestetten-laufen-uhwiesen-dorfstrasse': 'zurigo-germania',
  'jestetten-laufen-uhwiesen-grenzstrasse': 'zurigo-germania',
  'jestetten-neuhausen-am-rheinfall-zollstrasse': 'sciaffusa-germania',
  'jestetten-wilchingen': 'sciaffusa-germania',
  'klettgau-trasadingen': 'sciaffusa-germania',
  'stuhlingen-schleitheim': 'sciaffusa-germania',
  'blumberg-beggingen': 'sciaffusa-germania',
  'blumberg-bargen-sh-autostrasse-h4': 'sciaffusa-germania',
  'tengen-thayngen-l188': 'sciaffusa-germania',
  'gottmadingen-thayngen-ebringerstrasse': 'sciaffusa-germania',
  'gottmadingen-thayngen-autostrada-a81-a4': 'sciaffusa-germania',
  'dorflingen-gottmadingen-randegg': 'sciaffusa-germania',
  'ramsen-moskau-rielasingen-worblingen': 'sciaffusa-germania',
  'ohningen-stein-am-rhein': 'sciaffusa-germania',
  'gailingen-am-hochrhein-dorflingen': 'sciaffusa-germania',
  'lottstetten-rudlingen': 'sciaffusa-germania',
  'jestetten-neuhausen-am-rheinfall-buchweg': 'sciaffusa-germania',
  'klettgau-wilchingen': 'sciaffusa-germania',
  'eggingen-hallau': 'sciaffusa-germania',
  'stuhlingen-hallau': 'sciaffusa-germania',
  'blumberg-bargen-sh-alte-bargener-strasse': 'sciaffusa-germania',
  'bargen-sh-tengen': 'sciaffusa-germania',
  'merishausen-tengen': 'sciaffusa-germania',
  'opfertshofen-tengen': 'sciaffusa-germania',
  'tengen-thayngen-wiechserstrasse': 'sciaffusa-germania',
  'hilzingen-thayngen-schlattergasse': 'sciaffusa-germania',
  'hilzingen-thayngen-barzheimer-strasse': 'sciaffusa-germania',
  'dorflingen-gailingen-am-hochrhein-hinterdorf': 'sciaffusa-germania',
  'busingen-am-hochrhein-dorflingen-l202': 'sciaffusa-germania',
  'busingen-am-hochrhein-dorflingen-busingerstrasse': 'sciaffusa-germania',
  'busingen-am-hochrhein-dorflingen-siedlerstrasse': 'sciaffusa-germania',
  'busingen-am-hochrhein-schaffhausen-gennersbrunnerstrasse': 'sciaffusa-germania',
  'busingen-am-hochrhein-schaffhausen-stemmer': 'sciaffusa-germania',
  'busingen-am-hochrhein-schaffhausen-felsgasse': 'sciaffusa-germania',
  'busingen-am-hochrhein-schaffhausen-vogelingasschen': 'sciaffusa-germania',
  'busingen-am-hochrhein-schaffhausen-rheinhaldenstrasse': 'sciaffusa-germania',
  'gailingen-am-hochrhein-ramsen-sh': 'sciaffusa-germania',
  'gottmadingen-buch-sh': 'sciaffusa-germania',
  'gottmadingen-buch-blindenhausen-sh': 'sciaffusa-germania',
  'gottmadingen-ramsen-hofenacker': 'sciaffusa-germania',
  'rielasingen-worblingen-ramsen-hofenacker': 'sciaffusa-germania',
  'diessenhofen-gailingen-am-hochrhein': 'turgovia-germania',
  'konstanz-tagerwilen-gottlieber-strasse': 'turgovia-germania',
  'konstanz-tagerwilen-autostrada-b33n-a7': 'turgovia-germania',
  'konstanz-kreuzlingen': 'turgovia-germania',
  'rheineck-gai-au': 'san-gallo-austria',
  'st-margrethen-hochst': 'san-gallo-austria',
  'au-lustenau': 'san-gallo-austria',
  'widnau-lustenau': 'san-gallo-austria',
  'diepoldsau-hohenems': 'san-gallo-austria',
  'kriessern-mader': 'san-gallo-austria',
  'montlingen-koblach': 'san-gallo-austria',
  'ruthi-meiningen': 'san-gallo-austria',
  'martina-nauders': 'grigioni-austria',
  'samnaun-spiss': 'grigioni-austria',
  'trubbach-balzers': 'san-gallo-liechtenstein',
  'sevelen-vaduz': 'san-gallo-liechtenstein',
  'buchs-schaan': 'san-gallo-liechtenstein',
  'haag-bendern': 'san-gallo-liechtenstein',
  'salez-ruggell': 'san-gallo-liechtenstein',
  'st-luzisteig': 'grigioni-liechtenstein',
  bardonnex: 'geneve-francia',
  'ferney-voltaire-grand-saconnex': 'geneve-francia',
  'meyrin-cern': 'geneve-francia',
  'thonex-vallard': 'geneve-francia',
  moillesulaz: 'geneve-francia',
  perly: 'geneve-francia',
  anieres: 'geneve-francia',
  sauverny: 'geneve-francia',
  hermance: 'geneve-francia',
  landecy: 'geneve-francia',
  'vallorbe-jougne': 'vaud-francia',
  'la-cure-les-rousses': 'vaud-francia',
  'l-auberson-les-fourgs': 'vaud-francia',
  'le-brassus-bois-d-amont': 'vaud-francia',
  'crassier-divonne': 'vaud-francia',
  'chavannes-de-bogis-divonne': 'vaud-francia',
  'les-verrieres': 'neuchatel-francia',
  'col-des-roches': 'neuchatel-francia',
  biaufond: 'neuchatel-francia',
  'boncourt-delle': 'giura-francia',
  'fahy-abbevillers': 'giura-francia',
  goumois: 'giura-francia',
  'le-chatelard-vallorcine': 'vallese-francia',
  'saint-gingolph': 'vallese-francia',
  'morgins-chatel': 'vallese-francia',
};

/**
 * Closest fuel-daily zone for each crossing (used by related-links helper).
 * `Partial` because fuel-daily is a Ticino-only feature — non-Ticino
 * crossings (e.g. the Germania corridor) have no "nearest Ticino zone" and
 * are deliberately left absent rather than fabricating one; the
 * related-links helper falls back to nationwide links when absent (see
 * `clustersForBorderWait` in build-plugins/shared/relatedLinks.ts). New
 * Ticino crossing → add its nearest zone here; extend the union first if
 * none of the existing 3 fits (checklist above BorderCrossingRegion, step
 * 8).
 */
export const CROSSING_TO_FUEL_ZONE: Partial<Record<BorderCrossingSlug, 'chiasso' | 'mendrisio' | 'lugano'>> = {
  'chiasso-centro': 'chiasso',
  'chiasso-brogeda': 'chiasso',
  'chiasso-strada': 'chiasso',
  'maslianico-pizzamiglio': 'chiasso',
  'maslianico-roggiana': 'chiasso',
  'bizzarone-novazzano': 'chiasso',
  'ronago-novazzano': 'chiasso',
  'crociale-dei-mulini': 'chiasso',
  'drezzo-pedrinate': 'chiasso',
  'lanzo-d-intelvi-arogno': 'lugano',
  'campione-d-italia-bissone': 'lugano',
  'oria-gandria': 'lugano',
  gaggiolo: 'mendrisio',
  'san-pietro': 'mendrisio',
  'clivio-ligornetto': 'mendrisio',
  'rodero-stabio': 'mendrisio',
  'saltrio-arzo': 'mendrisio',
  'ponte-tresa': 'lugano',
  'porto-ceresio-brusino': 'lugano',
  'cremenaga-ponte-cremenaga': 'lugano',
  'luino-fornasette': 'lugano',
  'zenna-dirinella': 'lugano',
  'biegno-indemini': 'lugano',
  'dumenza-cassinone': 'lugano',
  camedo: 'lugano',
  'piaggio-valmara': 'lugano',
};

/**
 * Closest weekly-employers city slug for each crossing. `Partial` for the
 * same reason as CROSSING_TO_FUEL_ZONE above — weekly-employers (and,
 * transitively, cost-of-living/job-market-snapshot which are derived from
 * this map in relatedLinks.ts) is Ticino-only; non-Ticino crossings are
 * left absent. New Ticino crossing → add its nearest city here; extend the
 * union first if none of the existing values fits (checklist above
 * BorderCrossingRegion, step 9).
 */
export const CROSSING_TO_WEEKLY_CITY: Partial<
  Record<BorderCrossingSlug, 'chiasso' | 'mendrisio' | 'lugano'>
> = {
  'chiasso-centro': 'chiasso',
  'chiasso-brogeda': 'chiasso',
  'chiasso-strada': 'chiasso',
  'maslianico-pizzamiglio': 'chiasso',
  'maslianico-roggiana': 'chiasso',
  'bizzarone-novazzano': 'chiasso',
  'ronago-novazzano': 'chiasso',
  'crociale-dei-mulini': 'chiasso',
  'drezzo-pedrinate': 'chiasso',
  'lanzo-d-intelvi-arogno': 'lugano',
  'campione-d-italia-bissone': 'lugano',
  'oria-gandria': 'lugano',
  gaggiolo: 'mendrisio',
  'san-pietro': 'mendrisio',
  'clivio-ligornetto': 'mendrisio',
  'rodero-stabio': 'mendrisio',
  'saltrio-arzo': 'mendrisio',
  'ponte-tresa': 'lugano',
  'porto-ceresio-brusino': 'lugano',
  'cremenaga-ponte-cremenaga': 'lugano',
  'luino-fornasette': 'lugano',
  'zenna-dirinella': 'lugano',
  'biegno-indemini': 'lugano',
  'dumenza-cassinone': 'lugano',
  camedo: 'lugano',
  'piaggio-valmara': 'lugano',
};

// ── URL slug tables ───────────────────────────────────────────────

export const BORDER_WAIT_LOCALE_PREFIX: Record<BorderWaitLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/** Top-level section slug per locale. */
export const BORDER_WAIT_SECTION: Record<BorderWaitLocale, string> = {
  it: 'traffico-dogane',
  en: 'border-wait',
  de: 'wartezeit-grenze',
  fr: 'temps-attente-douane',
};

/** "Today" keyword per locale. */
export const BORDER_WAIT_TODAY_SLUG: Record<BorderWaitLocale, string> = {
  it: 'oggi',
  en: 'today',
  de: 'heute',
  fr: 'aujourd-hui',
};

/**
 * Every BorderCrossingRegion member, as a runtime array — same across
 * locales. New region → append it here too (checklist above
 * BorderCrossingRegion, step 3).
 */
export const BORDER_WAIT_REGIONS: readonly BorderCrossingRegion[] = [
  'ticino-como',
  'ticino-varese',
  'ticino-verbano',
  'basilea-germania',
  'argovia-germania',
  'zurigo-germania',
  'sciaffusa-germania',
  'turgovia-germania',
  'san-gallo-austria',
  'grigioni-austria',
  'san-gallo-liechtenstein',
  'grigioni-liechtenstein',
  'geneve-francia',
  'vaud-francia',
  'neuchatel-francia',
  'giura-francia',
  'vallese-francia',
] as const;

/**
 * Region display labels. New region → add its label here (checklist above
 * BorderCrossingRegion, step 2).
 */
export const BORDER_REGION_DISPLAY: Record<BorderCrossingRegion, string> = {
  'ticino-como': 'Ticino — Como',
  'ticino-varese': 'Ticino — Varese',
  'ticino-verbano': 'Ticino — Verbano',
  'basilea-germania': 'Basilea — Germania',
  'argovia-germania': 'Argovia — Germania',
  'zurigo-germania': 'Zurigo — Germania',
  'sciaffusa-germania': 'Sciaffusa — Germania',
  'turgovia-germania': 'Turgovia — Germania',
  'san-gallo-austria': 'San Gallo — Austria',
  'grigioni-austria': 'Grigioni — Austria',
  'san-gallo-liechtenstein': 'San Gallo — Liechtenstein',
  'grigioni-liechtenstein': 'Grigioni — Liechtenstein',
  'geneve-francia': 'Ginevra — Francia',
  'vaud-francia': 'Vaud — Francia',
  'neuchatel-francia': 'Neuchâtel — Francia',
  'giura-francia': 'Giura — Francia',
  'vallese-francia': 'Vallese — Francia',
};

/**
 * Which foreign country each region's crossings lead into. Several page
 * templates (see `borderWaitPagesPlugin.ts`'s `paragraph()` copy and the
 * `direction` computation) contain country-specific facts (customs
 * authority nationality, "returning to X after work" phrasing, CH↔X
 * direction labels) that must not be hardcoded to Italy once non-Italy
 * corridors exist. New region → add its country here too (checklist above
 * BorderCrossingRegion, step 2b) — kept an exhaustive Record on purpose so
 * a forgotten entry is a compile error, not a silently-wrong page.
 */
export const REGION_TO_COUNTRY: Record<BorderCrossingRegion, 'IT' | 'DE' | 'AT' | 'LI' | 'FR'> = {
  'ticino-como': 'IT',
  'ticino-varese': 'IT',
  'ticino-verbano': 'IT',
  'basilea-germania': 'DE',
  'argovia-germania': 'DE',
  'zurigo-germania': 'DE',
  'sciaffusa-germania': 'DE',
  'turgovia-germania': 'DE',
  'san-gallo-austria': 'AT',
  'grigioni-austria': 'AT',
  'san-gallo-liechtenstein': 'LI',
  'grigioni-liechtenstein': 'LI',
  'geneve-francia': 'FR',
  'vaud-francia': 'FR',
  'neuchatel-francia': 'FR',
  'giura-francia': 'FR',
  'vallese-francia': 'FR',
};

/**
 * True for the 26 Ticino–Italy crossings, false for the 108 non-Ticino
 * (Germany/Austria/Liechtenstein/France corridor) ones. Single source of
 * truth for "is this crossing in scope for Ticino-only content" (evergreen
 * ranking article, monthly archive pages,
 * etc.) — derived from CROSSING_TO_REGION + REGION_TO_COUNTRY instead of a
 * second hand-maintained list, so a new non-Italy corridor is excluded
 * automatically instead of silently leaking into Ticino-scoped copy.
 */
export function isTicinoCrossing(crossing: BorderCrossingSlug): boolean {
  return REGION_TO_COUNTRY[CROSSING_TO_REGION[crossing]] === 'IT';
}

// ── Path builders ─────────────────────────────────────────────────

function joinPath(parts: string[]): string {
  const nonEmpty = parts.map((p) => String(p).replace(/^\/+|\/+$/g, '')).filter((p) => p.length > 0);
  return '/' + nonEmpty.join('/') + '/';
}

/** Build the canonical path for a per-crossing "today" page. */
export function buildOggiPath(locale: BorderWaitLocale, crossing: BorderCrossingSlug): string {
  return joinPath([
    BORDER_WAIT_LOCALE_PREFIX[locale],
    BORDER_WAIT_SECTION[locale],
    crossing,
    BORDER_WAIT_TODAY_SLUG[locale],
  ]);
}

/** Root hub: /traffico-dogane/ etc. */
export function buildRootHubPath(locale: BorderWaitLocale): string {
  return joinPath([BORDER_WAIT_LOCALE_PREFIX[locale], BORDER_WAIT_SECTION[locale]]);
}

/** Regional hub: /traffico-dogane/ticino-como/ etc. */
export function buildRegionalHubPath(locale: BorderWaitLocale, region: BorderCrossingRegion): string {
  return joinPath([BORDER_WAIT_LOCALE_PREFIX[locale], BORDER_WAIT_SECTION[locale], region]);
}

/** Monthly archive: /traffico-dogane/{crossing}/2026-04/. */
export function buildArchivePath(
  locale: BorderWaitLocale,
  crossing: BorderCrossingSlug,
  monthKey: string,
): string {
  return joinPath([
    BORDER_WAIT_LOCALE_PREFIX[locale],
    BORDER_WAIT_SECTION[locale],
    crossing,
    monthKey,
  ]);
}

// ── Route enumeration ─────────────────────────────────────────────

/**
 * All canonical "today" routes — regional hubs + per-crossing. Imported by
 * services/router.ts so unknown `/traffico-dogane/...` URLs resolve to a known
 * route (guida/border sub-tab) instead of falling through to 404.
 *
 * Count: 4 locales × (1 root + 17 regional + 134 crossings) = 608 canonical paths.
 */
export const BORDER_WAIT_ROUTES: readonly string[] = (() => {
  const out: string[] = [];
  for (const locale of BORDER_WAIT_LOCALES) {
    out.push(buildRootHubPath(locale));
    for (const region of BORDER_WAIT_REGIONS) {
      out.push(buildRegionalHubPath(locale, region));
    }
    for (const crossing of BORDER_WAIT_CROSSINGS) {
      out.push(buildOggiPath(locale, crossing));
    }
  }
  return out;
})();

const BORDER_WAIT_ROUTE_SET: ReadonlySet<string> = new Set(BORDER_WAIT_ROUTES);

/** O(1) router matcher (accepts paths with or without trailing slash). */
export function isBorderWaitPath(pathname: string): boolean {
  if (!pathname) return false;
  const leading = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const normalised = leading.endsWith('/') ? leading : `${leading}/`;
  if (BORDER_WAIT_ROUTE_SET.has(normalised)) return true;
  return isBorderWaitArchivePath(normalised);
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const CROSSING_SET: ReadonlySet<string> = new Set(BORDER_WAIT_CROSSINGS as readonly string[]);

/** Return true when the path ends in /YYYY-MM/ under a border-wait section. */
export function isBorderWaitArchivePath(pathname: string): boolean {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 3) return false;
  let idx = 0;
  if (parts[0] === 'en' || parts[0] === 'de' || parts[0] === 'fr') idx = 1;
  const section = parts[idx];
  const matchesSection = BORDER_WAIT_LOCALES.some((l) => BORDER_WAIT_SECTION[l] === section);
  if (!matchesSection) return false;
  const crossing = parts[idx + 1];
  const month = parts[idx + 2];
  if (!crossing || !CROSSING_SET.has(crossing)) return false;
  if (!month || !MONTH_PATTERN.test(month)) return false;
  return idx + 2 === parts.length - 1;
}

// ── Path parser ───────────────────────────────────────────────────

export interface ParsedBorderWaitPath {
  locale: BorderWaitLocale;
  crossing?: BorderCrossingSlug;
  region?: BorderCrossingRegion;
  monthKey?: string;
  isRoot?: boolean;
  isToday?: boolean;
  isRegional?: boolean;
  isArchive?: boolean;
}

/**
 * Reverse-lookup: given a pathname, return its parsed form if it matches a
 * border-wait route shape, else null. Used by services/router.ts.
 */
export function parseBorderWaitPath(pathname: string): ParsedBorderWaitPath | null {
  if (!pathname) return null;
  const leading = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const normalised = leading.endsWith('/') ? leading : `${leading}/`;
  const parts = normalised.split('/').filter(Boolean);
  if (parts.length === 0) return null;

  // Detect locale prefix
  let locale: BorderWaitLocale = 'it';
  let idx = 0;
  if (parts[0] === 'en' || parts[0] === 'de' || parts[0] === 'fr') {
    locale = parts[0] as BorderWaitLocale;
    idx = 1;
  }

  // Section must match the locale's section slug
  const section = parts[idx];
  if (section !== BORDER_WAIT_SECTION[locale]) return null;
  idx++;

  // Root hub: /traffico-dogane/
  if (idx === parts.length) {
    return { locale, isRoot: true };
  }

  // /traffico-dogane/ticino-como/ — regional hub
  const maybeRegion = parts[idx] as BorderCrossingRegion;
  if ((BORDER_WAIT_REGIONS as readonly string[]).includes(maybeRegion) && idx === parts.length - 1) {
    return { locale, region: maybeRegion, isRegional: true };
  }

  // /traffico-dogane/{crossing}/{oggi|YYYY-MM}
  const maybeCrossing = parts[idx] as BorderCrossingSlug;
  if (!CROSSING_SET.has(maybeCrossing)) return null;
  idx++;
  if (idx >= parts.length) return null;

  const tail = parts[idx];
  if (tail === BORDER_WAIT_TODAY_SLUG[locale] && idx === parts.length - 1) {
    return { locale, crossing: maybeCrossing, isToday: true };
  }
  if (MONTH_PATTERN.test(tail) && idx === parts.length - 1) {
    return { locale, crossing: maybeCrossing, monthKey: tail, isArchive: true };
  }
  return null;
}
