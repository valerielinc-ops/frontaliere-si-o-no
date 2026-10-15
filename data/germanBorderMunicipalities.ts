/**
 * germanBorderMunicipalities.ts — raw candidate dataset for the per-municipality
 * GERMANY border pages (issue #4882, third of the FR/DE/AT/LI rollout after
 * France #4545/#4878).
 *
 * Analogous to data/frenchBorderMunicipalities.ts: a hand-maintained flat
 * literal array, one object per line, parsed by
 * scripts/build-german-border-municipalities.mjs to derive
 * data/german-border-municipalities.json (above/below-floor split applied
 * there, NOT stored here — this file is the raw candidate list only).
 *
 * CANDIDATE UNIVERSE (deliberately NOT the `foreignSide` of data/borderCrossings.ts)
 * -------------------------------------------------------------------------
 * The 67 DE rows in data/borderCrossings.ts carry `province` = Landkreis, which
 * this dataset verified is exactly 4 values: Lörrach, Waldshut, Konstanz,
 * Schwarzwald-Baar-Kreis (all Regierungsbezirk Freiburg, Baden-Württemberg).
 * The candidate list below is ALL 112 politically independent Gemeinden of
 * those 4 Landkreise per the official nationwide registry (see SOURCES) — not
 * the 67 crossings' `foreignSide` values. `foreignSide` deliberately mixes
 * Ortsteile/Stadtteile with real Gemeinden (e.g. "Lörrach-Stetten" is a
 * Stadtteil of Lörrach, "Gottmadingen (Randegg)" a Teilort of Gottmadingen —
 * neither is its own municipality) and only covers towns that happen to host
 * a crossing, silently excluding populous non-crossing-hosting neighbours.
 * Enumerating from the full Landkreis registry instead avoids both defects.
 *
 * SOURCES (verified 2026-07-29, all primary/official, no paid tool)
 * -------------------------------------------------------------------------
 * - name / ags / landkreis / lat / lng / population / plz: Statistisches
 *   Bundesamt (Destatis), "Gemeindeverzeichnis-Informationssystem (GV-ISys)",
 *   online extract "Alle politisch selbständigen Gemeinden mit ausgewählten
 *   Merkmalen am 31.12.2025 (4. Quartal)" (published 2026-01-07):
 *   https://www.destatis.de/DE/Themen/Laender-Regionen/Regionales/Gemeindeverzeichnis/Administrativ/Archiv/GVAuszugQ/AuszugGV4QAktuell.xlsx
 *   This is the nationwide official municipality registry (the German
 *   equivalent of INSEE's COG, used the same way geo.api.gouv.fr was used for
 *   the French twin). Two DIFFERENT reference dates inside the same extract,
 *   both stated explicitly by the source (not assumed):
 *     - `population`: "Bevölkerung auf Grundlage des Zensus 2022,
 *       fortgeschrieben" AS OF 31.12.2024 (row 5 of the sheet states this
 *       date for the population column specifically, one year behind the
 *       area/PLZ/boundary columns below).
 *     - boundaries (which Gemeinden exist / were merged), `plz`, and the
 *       `lat`/`lng` centroid ("Geografische Mittelpunktkoordinaten") are AS
 *       OF 31.12.2025.
 *   `ags` = Amtlicher Gemeindeschlüssel (8-digit: Land+RB+Kreis+Gemeinde),
 *   read directly from the registry's own ARS columns (C–G), not recomputed.
 *   `landkreis`: resolved from the registry's own Kreis-level header rows
 *   (Satzart 40) inside the same file — independently cross-checked against
 *   the `province` values already in data/borderCrossings.ts (exact match,
 *   4/4).
 *   Name cleanup: the registry appends a legal-status suffix to some names
 *   (", Stadt" / ", Universitätsstadt", e.g. "Lörrach, Stadt", "Konstanz,
 *   Universitätsstadt") that is not used in common reference (Wikipedia,
 *   everyday usage) — stripped here for the `name` field to match how
 *   Italian/French municipalities are named in this codebase. The full
 *   88-suffix set found in the source was exactly {"Stadt",
 *   "Universitätsstadt"}; no other variant occurred among these 112 rows.
 * - distanceKm / nearestCrossing / canton: OSRM public routing server
 *   (router.project-osrm.org, /table/v1/driving endpoint) — REAL road-routing
 *   distance to the nearest of the 67 DE entries in data/borderCrossings.ts,
 *   NOT haversine. Same deliberate methodological choice as the French twin
 *   (see that file's header for why this diverges from data/municipalities.ts's
 *   haversine-only distanceKm). For request-size/politeness reasons each
 *   municipality was matched against only its 25 nearest-by-haversine
 *   crossings (not all 67) before the real-road query — safe because, in
 *   this Rhine-valley/Black-Forest terrain, the road/haversine ratio for the
 *   true-nearest crossing never approaches the margin needed for a crossing
 *   ranked >25th-by-haversine to become nearest-by-road; this candidate
 *   pruning affects only the `nearestCrossing` label for below-floor rows,
 *   never the above/below-floor split itself (all above-floor rows' nearest
 *   crossing is <20km, deep inside the top-25 by either metric).
 * - `canton`: the Swiss canton (BS/AG/ZH/SH/TG) of the resolved
 *   `nearestCrossing`, read from data/borderCrossings.ts — purely geographic
 *   here, NOT a fiscal-regime driver (see REGIME note below).
 *
 * REGIME (fiscal mechanism — deliberately NOT derived from `canton`)
 * -------------------------------------------------------------------------
 * Unlike the French corridor (Genève source-tax vs Vaud/Neuchâtel/Jura/Valais
 * declaration — a real per-canton split, see frenchBorderMunicipalities.ts),
 * the German Grenzgänger regime under Art. 15a DBA Deutschland/Schweiz is
 * UNIFORM regardless of which Swiss canton employs the frontaliere: 4.5%
 * Quellensteuer on gross pay, Germany credits it via Anrechnungsmethode, with
 * the >60-Nichtrückkehrtage-per-year carve-out — verified against primary
 * BMF sources, see the fiscal research doc's "Passo 1" (Art. 15a section).
 * `canton` is therefore kept per-row purely as geographic/informational
 * metadata (which Swiss canton this municipality's frontalieri most likely
 * commute into), NOT wired to a CANTON_REGIME map the way the French
 * builder's is — a single regime label applies to every row uniformly (see
 * scripts/build-german-border-municipalities.mjs).
 *
 * NOT INCLUDED (scope of issue #4882 was the municipality registry only)
 * -------------------------------------------------------------------------
 * No `avgRentMonthly`/rent fields: unlike the French twin, no German rent
 * source has been researched for this dataset yet — omitted rather than
 * fabricated. A future task sourcing German municipality-level rent data
 * (e.g. a Destatis/Land-level "Mietspiegel" equivalent) can extend this
 * interface additively.
 */

export interface GermanBorderMunicipalityRaw {
  name: string;
  /** Amtlicher Gemeindeschlüssel — 8-digit official municipality code. */
  ags: string;
  landkreis: 'Lörrach' | 'Waldshut' | 'Konstanz' | 'Schwarzwald-Baar-Kreis';
  lat: number;
  lng: number;
  /** Zensus-2022-based population, fortgeschrieben as of 2024-12-31 (Destatis). */
  population: number;
  /** Postleitzahl (postal code), as of 2025-12-31 (Destatis). */
  plz: string;
  distanceKm: number;
  nearestCrossing: string;
  /** Swiss canton of the nearest crossing — geographic only, see REGIME note above. */
  canton: 'BS' | 'AG' | 'ZH' | 'SH' | 'TG';
}

export const GERMAN_BORDER_MUNICIPALITIES: GermanBorderMunicipalityRaw[] = [
 // ── Lörrach — 35 comuni ──
 { name: 'Lörrach', ags: '08336050', landkreis: 'Lörrach', lat: 47.612096, lng: 7.659191, population: 51349, plz: '79539', distanceKm: 2.5, nearestCrossing: 'Riehen – Lörrach-Stetten', canton: 'BS' },
 { name: 'Rheinfelden (Baden)', ags: '08336069', landkreis: 'Lörrach', lat: 47.561128, lng: 7.78365, population: 34674, plz: '79618', distanceKm: 0.7, nearestCrossing: 'Rheinfelden (Baden) – Rheinfelden AG, Alte Rheinbrücke', canton: 'AG' },
 { name: 'Weil am Rhein', ags: '08336091', landkreis: 'Lörrach', lat: 47.594284, lng: 7.629579, population: 32236, plz: '79576', distanceKm: 1.8, nearestCrossing: 'Riehen – Weil am Rhein', canton: 'BS' },
 { name: 'Schopfheim', ags: '08336081', landkreis: 'Lörrach', lat: 47.650141, lng: 7.822962, population: 20332, plz: '79650', distanceKm: 14.1, nearestCrossing: 'Rheinfelden (Baden) – Rheinfelden AG, Alte Rheinbrücke', canton: 'AG' },
 { name: 'Grenzach-Wyhlen', ags: '08336105', landkreis: 'Lörrach', lat: 47.553081, lng: 7.658946, population: 15476, plz: '79639', distanceKm: 2.3, nearestCrossing: 'Grenzach-Wyhlen – Riehen', canton: 'BS' },
 { name: 'Steinen', ags: '08336084', landkreis: 'Lörrach', lat: 47.643739, lng: 7.73952, population: 10409, plz: '79585', distanceKm: 11.9, nearestCrossing: 'Riehen – Lörrach-Stetten', canton: 'BS' },
 { name: 'Kandern', ags: '08336045', landkreis: 'Lörrach', lat: 47.714834, lng: 7.662899, population: 8710, plz: '79400', distanceKm: 16.5, nearestCrossing: 'Riehen – Lörrach-Stetten', canton: 'BS' },
 { name: 'Efringen-Kirchen', ags: '08336014', landkreis: 'Lörrach', lat: 47.649597, lng: 7.565548, population: 8683, plz: '79588', distanceKm: 8.3, nearestCrossing: 'Basel – Weil am Rhein, Hiltalingerstrasse', canton: 'BS' },
 { name: 'Zell im Wiesental', ags: '08336103', landkreis: 'Lörrach', lat: 47.707567, lng: 7.852117, population: 6204, plz: '79669', distanceKm: 22.1, nearestCrossing: 'Rheinfelden (Baden) – Rheinfelden AG, Alte Rheinbrücke', canton: 'AG' },
 { name: 'Schliengen', ags: '08336078', landkreis: 'Lörrach', lat: 47.754977, lng: 7.577673, population: 6200, plz: '79418', distanceKm: 24, nearestCrossing: 'Basel – Weil am Rhein, Hiltalingerstrasse', canton: 'BS' },
 { name: 'Bad Bellingen', ags: '08336006', landkreis: 'Lörrach', lat: 47.731696, lng: 7.556809, population: 5134, plz: '79415', distanceKm: 20.5, nearestCrossing: 'Basel – Weil am Rhein, Hiltalingerstrasse', canton: 'BS' },
 { name: 'Todtnau', ags: '08336087', landkreis: 'Lörrach', lat: 47.82939, lng: 7.947591, population: 4960, plz: '79674', distanceKm: 40.5, nearestCrossing: 'Rheinfelden (Baden) – Rheinfelden AG, Alte Rheinbrücke', canton: 'AG' },
 { name: 'Maulburg', ags: '08336057', landkreis: 'Lörrach', lat: 47.640837, lng: 7.77816, population: 4366, plz: '79689', distanceKm: 13.2, nearestCrossing: 'Rheinfelden (Baden) – Rheinfelden AG, Alte Rheinbrücke', canton: 'AG' },
 { name: 'Binzen', ags: '08336008', landkreis: 'Lörrach', lat: 47.631528, lng: 7.627773, population: 2988, plz: '79589', distanceKm: 6.7, nearestCrossing: 'Basel – Weil am Rhein, Freiburgerstrasse', canton: 'BS' },
 { name: 'Kleines Wiesental', ags: '08336107', landkreis: 'Lörrach', lat: 47.71944, lng: 7.794808, population: 2970, plz: '79692', distanceKm: 23.6, nearestCrossing: 'Rheinfelden (Baden) – Rheinfelden AG, Alte Rheinbrücke', canton: 'AG' },
 { name: 'Inzlingen', ags: '08336043', landkreis: 'Lörrach', lat: 47.587829, lng: 7.690549, population: 2555, plz: '79594', distanceKm: 1.6, nearestCrossing: 'Inzlingen – Riehen', canton: 'BS' },
 { name: 'Schwörstadt', ags: '08336082', landkreis: 'Lörrach', lat: 47.594036, lng: 7.881039, population: 2531, plz: '79739', distanceKm: 8, nearestCrossing: 'Bad Säckingen – Stein AG', canton: 'AG' },
 { name: 'Eimeldingen', ags: '08336019', landkreis: 'Lörrach', lat: 47.630772, lng: 7.595534, population: 2529, plz: '79591', distanceKm: 7, nearestCrossing: 'Basel – Weil am Rhein, Hiltalingerstrasse', canton: 'BS' },
 { name: 'Schönau im Schwarzwald', ags: '08336079', landkreis: 'Lörrach', lat: 47.786085, lng: 7.894115, population: 2504, plz: '79677', distanceKm: 33.3, nearestCrossing: 'Rheinfelden (Baden) – Rheinfelden AG, Alte Rheinbrücke', canton: 'AG' },
 { name: 'Hausen im Wiesental', ags: '08336036', landkreis: 'Lörrach', lat: 47.681727, lng: 7.8401, population: 2371, plz: '79688', distanceKm: 19.1, nearestCrossing: 'Rheinfelden (Baden) – Rheinfelden AG, Alte Rheinbrücke', canton: 'AG' },
 { name: 'Rümmingen', ags: '08336073', landkreis: 'Lörrach', lat: 47.641307, lng: 7.642922, population: 1989, plz: '79595', distanceKm: 7.5, nearestCrossing: 'Riehen – Lörrach-Stetten', canton: 'BS' },
 { name: 'Malsburg-Marzell', ags: '08336104', landkreis: 'Lörrach', lat: 47.731941, lng: 7.708589, population: 1443, plz: '79429', distanceKm: 20.6, nearestCrossing: 'Riehen – Lörrach-Stetten', canton: 'BS' },
 { name: 'Hasel', ags: '08336034', landkreis: 'Lörrach', lat: 47.654288, lng: 7.897903, population: 1237, plz: '79686', distanceKm: 15.3, nearestCrossing: 'Bad Säckingen – Stein AG', canton: 'AG' },
 { name: 'Wittlingen', ags: '08336100', landkreis: 'Lörrach', lat: 47.65692, lng: 7.648466, population: 930, plz: '79599', distanceKm: 9.2, nearestCrossing: 'Riehen – Lörrach-Stetten', canton: 'BS' },
 { name: 'Schallbach', ags: '08336075', landkreis: 'Lörrach', lat: 47.654705, lng: 7.626845, population: 855, plz: '79597', distanceKm: 9.7, nearestCrossing: 'Riehen – Lörrach-Stetten', canton: 'BS' },
 { name: 'Häg-Ehrsberg', ags: '08336106', landkreis: 'Lörrach', lat: 47.742861, lng: 7.906265, population: 810, plz: '79685', distanceKm: 32.2, nearestCrossing: 'Rheinfelden (Baden) – Rheinfelden AG, Alte Rheinbrücke', canton: 'AG' },
 { name: 'Fischingen', ags: '08336024', landkreis: 'Lörrach', lat: 47.650526, lng: 7.597834, population: 778, plz: '79592', distanceKm: 9, nearestCrossing: 'Basel – Weil am Rhein, Freiburgerstrasse', canton: 'BS' },
 { name: 'Utzenfeld', ags: '08336090', landkreis: 'Lörrach', lat: 47.801761, lng: 7.916875, population: 596, plz: '79694', distanceKm: 35.9, nearestCrossing: 'Rheinfelden (Baden) – Rheinfelden AG, Alte Rheinbrücke', canton: 'AG' },
 { name: 'Wieden', ags: '08336096', landkreis: 'Lörrach', lat: 47.841721, lng: 7.88345, population: 560, plz: '79695', distanceKm: 42.1, nearestCrossing: 'Rheinfelden (Baden) – Rheinfelden AG, Alte Rheinbrücke', canton: 'AG' },
 { name: 'Aitern', ags: '08336004', landkreis: 'Lörrach', lat: 47.803346, lng: 7.894621, population: 487, plz: '79677', distanceKm: 36, nearestCrossing: 'Rheinfelden (Baden) – Rheinfelden AG, Alte Rheinbrücke', canton: 'AG' },
 { name: 'Fröhnd', ags: '08336025', landkreis: 'Lörrach', lat: 47.758286, lng: 7.883067, population: 487, plz: '79677', distanceKm: 30.6, nearestCrossing: 'Rheinfelden (Baden) – Rheinfelden AG, Alte Rheinbrücke', canton: 'AG' },
 { name: 'Schönenberg', ags: '08336080', landkreis: 'Lörrach', lat: 47.793602, lng: 7.880934, population: 330, plz: '79677', distanceKm: 35, nearestCrossing: 'Rheinfelden (Baden) – Rheinfelden AG, Alte Rheinbrücke', canton: 'AG' },
 { name: 'Wembach', ags: '08336094', landkreis: 'Lörrach', lat: 47.772937, lng: 7.888029, population: 304, plz: '79677', distanceKm: 31.7, nearestCrossing: 'Rheinfelden (Baden) – Rheinfelden AG, Alte Rheinbrücke', canton: 'AG' },
 { name: 'Tunau', ags: '08336089', landkreis: 'Lörrach', lat: 47.786246, lng: 7.923595, population: 184, plz: '79677', distanceKm: 36.6, nearestCrossing: 'Rheinfelden (Baden) – Rheinfelden AG, Alte Rheinbrücke', canton: 'AG' },
 { name: 'Böllen', ags: '08336010', landkreis: 'Lörrach', lat: 47.801742, lng: 7.839713, population: 92, plz: '79677', distanceKm: 36.8, nearestCrossing: 'Riehen – Lörrach-Stetten', canton: 'BS' },
 // ── Waldshut — 32 comuni ──
 { name: 'Waldshut-Tiengen', ags: '08337126', landkreis: 'Waldshut', lat: 47.632439, lng: 8.271113, population: 25019, plz: '79761', distanceKm: 4.4, nearestCrossing: 'Waldshut-Tiengen – Koblenz AG', canton: 'AG' },
 { name: 'Bad Säckingen', ags: '08337096', landkreis: 'Waldshut', lat: 47.552535, lng: 7.948758, population: 17767, plz: '79713', distanceKm: 2.1, nearestCrossing: 'Bad Säckingen – Stein AG', canton: 'AG' },
 { name: 'Wehr', ags: '08337116', landkreis: 'Waldshut', lat: 47.629747, lng: 7.904562, population: 13126, plz: '79664', distanceKm: 12.3, nearestCrossing: 'Bad Säckingen – Stein AG', canton: 'AG' },
 { name: 'Laufenburg (Baden)', ags: '08337066', landkreis: 'Waldshut', lat: 47.565321, lng: 8.061623, population: 9335, plz: '79725', distanceKm: 2.1, nearestCrossing: 'Laufenburg (Baden) – Laufenburg AG', canton: 'AG' },
 { name: 'Lauchringen', ags: '08337065', landkreis: 'Waldshut', lat: 47.630759, lng: 8.304688, population: 8137, plz: '79787', distanceKm: 6.7, nearestCrossing: 'Küssaberg – Bad Zurzach AG', canton: 'AG' },
 { name: 'Albbruck', ags: '08337002', landkreis: 'Waldshut', lat: 47.591149, lng: 8.130079, population: 7451, plz: '79774', distanceKm: 5.7, nearestCrossing: 'Laufenburg (Baden) – Laufenburg AG', canton: 'AG' },
 { name: 'Klettgau', ags: '08337062', landkreis: 'Waldshut', lat: 47.658934, lng: 8.420527, population: 7445, plz: '79771', distanceKm: 1.7, nearestCrossing: 'Klettgau – Trasadingen', canton: 'SH' },
 { name: 'Murg', ags: '08337076', landkreis: 'Waldshut', lat: 47.55475, lng: 8.020644, population: 6900, plz: '79730', distanceKm: 5.6, nearestCrossing: 'Laufenburg (Baden) – Laufenburg AG', canton: 'AG' },
 { name: 'Bonndorf im Schwarzwald', ags: '08337022', landkreis: 'Waldshut', lat: 47.819632, lng: 8.343011, population: 6802, plz: '79848', distanceKm: 16.8, nearestCrossing: 'Stühlingen – Schleitheim', canton: 'SH' },
 { name: 'Wutöschingen', ags: '08337123', landkreis: 'Waldshut', lat: 47.659937, lng: 8.366501, population: 6726, plz: '79793', distanceKm: 5.9, nearestCrossing: 'Eggingen – Hallau', canton: 'SH' },
 { name: 'Küssaberg', ags: '08337125', landkreis: 'Waldshut', lat: 47.589996, lng: 8.305426, population: 5520, plz: '79790', distanceKm: 0.5, nearestCrossing: 'Küssaberg – Bad Zurzach AG', canton: 'AG' },
 { name: 'Stühlingen', ags: '08337106', landkreis: 'Waldshut', lat: 47.745475, lng: 8.445849, population: 5351, plz: '79780', distanceKm: 1, nearestCrossing: 'Stühlingen – Schleitheim', canton: 'SH' },
 { name: 'Jestetten', ags: '08337060', landkreis: 'Waldshut', lat: 47.649692, lng: 8.567756, population: 5290, plz: '79798', distanceKm: 3, nearestCrossing: 'Jestetten – Rheinau', canton: 'ZH' },
 { name: 'Ühlingen-Birkendorf', ags: '08337128', landkreis: 'Waldshut', lat: 47.718673, lng: 8.317652, population: 5255, plz: '79777', distanceKm: 10.6, nearestCrossing: 'Eggingen – Hallau', canton: 'SH' },
 { name: 'Görwihl', ags: '08337038', landkreis: 'Waldshut', lat: 47.641249, lng: 8.07848, population: 4174, plz: '79733', distanceKm: 13.7, nearestCrossing: 'Laufenburg (Baden) – Laufenburg AG', canton: 'AG' },
 { name: 'St. Blasien', ags: '08337097', landkreis: 'Waldshut', lat: 47.761671, lng: 8.125605, population: 3818, plz: '79837', distanceKm: 26.2, nearestCrossing: 'Waldshut-Tiengen – Koblenz AG', canton: 'AG' },
 { name: 'Rickenbach', ags: '08337090', landkreis: 'Waldshut', lat: 47.619901, lng: 7.980212, population: 3764, plz: '79736', distanceKm: 13.1, nearestCrossing: 'Bad Säckingen – Stein AG', canton: 'AG' },
 { name: 'Hohentengen am Hochrhein', ags: '08337053', landkreis: 'Waldshut', lat: 47.570554, lng: 8.434369, population: 3633, plz: '79801', distanceKm: 1.4, nearestCrossing: 'Hohentengen am Hochrhein – Kaiserstuhl AG', canton: 'AG' },
 { name: 'Weilheim', ags: '08337118', landkreis: 'Waldshut', lat: 47.658072, lng: 8.24114, population: 3167, plz: '79809', distanceKm: 8.9, nearestCrossing: 'Waldshut-Tiengen – Koblenz AG', canton: 'AG' },
 { name: 'Herrischried', ags: '08337049', landkreis: 'Waldshut', lat: 47.665518, lng: 8.001829, population: 2648, plz: '79737', distanceKm: 17.6, nearestCrossing: 'Laufenburg (Baden) – Laufenburg AG', canton: 'AG' },
 { name: 'Höchenschwand', ags: '08337051', landkreis: 'Waldshut', lat: 47.735352, lng: 8.166213, population: 2563, plz: '79862', distanceKm: 19.7, nearestCrossing: 'Waldshut-Tiengen – Koblenz AG', canton: 'AG' },
 { name: 'Lottstetten', ags: '08337070', landkreis: 'Waldshut', lat: 47.627729, lng: 8.573676, population: 2313, plz: '79807', distanceKm: 1.4, nearestCrossing: 'Lottstetten – Rafz, Landstrasse', canton: 'ZH' },
 { name: 'Grafenhausen', ags: '08337039', landkreis: 'Waldshut', lat: 47.772892, lng: 8.262034, population: 2271, plz: '79865', distanceKm: 19.2, nearestCrossing: 'Eggingen – Hallau', canton: 'SH' },
 { name: 'Dogern', ags: '08337032', landkreis: 'Waldshut', lat: 47.60884, lng: 8.172428, population: 2254, plz: '79804', distanceKm: 6, nearestCrossing: 'Waldshut-Tiengen – Koblenz AG', canton: 'AG' },
 { name: 'Todtmoos', ags: '08337108', landkreis: 'Waldshut', lat: 47.739405, lng: 8.000825, population: 1938, plz: '79682', distanceKm: 27.9, nearestCrossing: 'Laufenburg (Baden) – Laufenburg AG', canton: 'AG' },
 { name: 'Bernau im Schwarzwald', ags: '08337013', landkreis: 'Waldshut', lat: 47.80166, lng: 8.036108, population: 1806, plz: '79872', distanceKm: 35.5, nearestCrossing: 'Waldshut-Tiengen – Koblenz AG', canton: 'AG' },
 { name: 'Eggingen', ags: '08337124', landkreis: 'Waldshut', lat: 47.700751, lng: 8.387665, population: 1762, plz: '79805', distanceKm: 2.5, nearestCrossing: 'Eggingen – Hallau', canton: 'SH' },
 { name: 'Dachsberg (Südschwarzwald)', ags: '08337027', landkreis: 'Waldshut', lat: 47.729949, lng: 8.100949, population: 1380, plz: '79875', distanceKm: 25.5, nearestCrossing: 'Laufenburg (Baden) – Laufenburg AG', canton: 'AG' },
 { name: 'Häusern', ags: '08337045', landkreis: 'Waldshut', lat: 47.754099, lng: 8.16842, population: 1304, plz: '79837', distanceKm: 22.5, nearestCrossing: 'Waldshut-Tiengen – Koblenz AG', canton: 'AG' },
 { name: 'Wutach', ags: '08337127', landkreis: 'Waldshut', lat: 47.837555, lng: 8.444351, population: 1192, plz: '79879', distanceKm: 13.7, nearestCrossing: 'Stühlingen – Schleitheim', canton: 'SH' },
 { name: 'Dettighofen', ags: '08337030', landkreis: 'Waldshut', lat: 47.623497, lng: 8.483506, population: 1131, plz: '79802', distanceKm: 1.4, nearestCrossing: 'Dettighofen – Wil ZH', canton: 'ZH' },
 { name: 'Ibach', ags: '08337059', landkreis: 'Waldshut', lat: 47.743143, lng: 8.067051, population: 337, plz: '79837', distanceKm: 31.2, nearestCrossing: 'Laufenburg (Baden) – Laufenburg AG', canton: 'AG' },
 // ── Konstanz — 25 comuni ──
 { name: 'Konstanz', ags: '08335043', landkreis: 'Konstanz', lat: 47.662757, lng: 9.175957, population: 86919, plz: '78462', distanceKm: 1.7, nearestCrossing: 'Konstanz – Kreuzlingen', canton: 'TG' },
 { name: 'Singen (Hohentwiel)', ags: '08335075', landkreis: 'Konstanz', lat: 47.759711, lng: 8.835117, population: 47621, plz: '78224', distanceKm: 6.2, nearestCrossing: 'Rielasingen-Worblingen – Ramsen-Hofenacker', canton: 'SH' },
 { name: 'Radolfzell am Bodensee', ags: '08335063', landkreis: 'Konstanz', lat: 47.739107, lng: 8.968663, population: 31734, plz: '78315', distanceKm: 13.9, nearestCrossing: 'Rielasingen-Worblingen – Ramsen-Hofenacker', canton: 'SH' },
 { name: 'Stockach', ags: '08335079', landkreis: 'Konstanz', lat: 47.848855, lng: 9.00899, population: 17646, plz: '78333', distanceKm: 25, nearestCrossing: 'Gottmadingen – Thayngen, Ebringerstrasse', canton: 'SH' },
 { name: 'Rielasingen-Worblingen', ags: '08335100', landkreis: 'Konstanz', lat: 47.728398, lng: 8.846, population: 12268, plz: '78239', distanceKm: 3, nearestCrossing: 'Rielasingen-Worblingen – Ramsen-Hofenacker', canton: 'SH' },
 { name: 'Engen', ags: '08335022', landkreis: 'Konstanz', lat: 47.854017, lng: 8.772115, population: 11311, plz: '78234', distanceKm: 13.1, nearestCrossing: 'Tengen – Thayngen, L188', canton: 'SH' },
 { name: 'Gottmadingen', ags: '08335028', landkreis: 'Konstanz', lat: 47.735149, lng: 8.777019, population: 10871, plz: '78244', distanceKm: 1.1, nearestCrossing: 'Gottmadingen – Buch-Blindenhausen SH', canton: 'SH' },
 { name: 'Hilzingen', ags: '08335035', landkreis: 'Konstanz', lat: 47.765627, lng: 8.777866, population: 9196, plz: '78247', distanceKm: 4.1, nearestCrossing: 'Gottmadingen – Thayngen, Ebringerstrasse', canton: 'SH' },
 { name: 'Allensbach', ags: '08335002', landkreis: 'Konstanz', lat: 47.715742, lng: 9.070194, population: 7353, plz: '78476', distanceKm: 10.4, nearestCrossing: 'Konstanz – Tägerwilen, Gottlieber Strasse', canton: 'TG' },
 { name: 'Reichenau', ags: '08335066', landkreis: 'Konstanz', lat: 47.698036, lng: 9.060705, population: 5189, plz: '78479', distanceKm: 10.1, nearestCrossing: 'Konstanz – Tägerwilen, Gottlieber Strasse', canton: 'TG' },
 { name: 'Steißlingen', ags: '08335077', landkreis: 'Konstanz', lat: 47.79781, lng: 8.92425, population: 5133, plz: '78256', distanceKm: 15.3, nearestCrossing: 'Rielasingen-Worblingen – Ramsen-Hofenacker', canton: 'SH' },
 { name: 'Bodman-Ludwigshafen', ags: '08335098', landkreis: 'Konstanz', lat: 47.821518, lng: 9.05777, population: 4838, plz: '78351', distanceKm: 29.6, nearestCrossing: 'Gottmadingen – Thayngen, Ebringerstrasse', canton: 'SH' },
 { name: 'Tengen', ags: '08335080', landkreis: 'Konstanz', lat: 47.821272, lng: 8.661028, population: 4818, plz: '78250', distanceKm: 7.1, nearestCrossing: 'Merishausen – Tengen', canton: 'SH' },
 { name: 'Mühlhausen-Ehingen', ags: '08335097', landkreis: 'Konstanz', lat: 47.810044, lng: 8.810044, population: 4054, plz: '78259', distanceKm: 12.6, nearestCrossing: 'Gottmadingen – Thayngen, Ebringerstrasse', canton: 'SH' },
 { name: 'Eigeltingen', ags: '08335021', landkreis: 'Konstanz', lat: 47.8592, lng: 8.897744, population: 3821, plz: '78253', distanceKm: 22.4, nearestCrossing: 'Rielasingen-Worblingen – Ramsen-Hofenacker', canton: 'SH' },
 { name: 'Orsingen-Nenzingen', ags: '08335099', landkreis: 'Konstanz', lat: 47.843112, lng: 8.958608, population: 3588, plz: '78359', distanceKm: 26.6, nearestCrossing: 'Gottmadingen – Thayngen, Ebringerstrasse', canton: 'SH' },
 { name: 'Öhningen', ags: '08335061', landkreis: 'Konstanz', lat: 47.661803, lng: 8.885442, population: 3559, plz: '78337', distanceKm: 0.9, nearestCrossing: 'Öhningen – Stein am Rhein', canton: 'SH' },
 { name: 'Moos', ags: '08335055', landkreis: 'Konstanz', lat: 47.726042, lng: 8.934137, population: 3417, plz: '78345', distanceKm: 11.8, nearestCrossing: 'Rielasingen-Worblingen – Ramsen-Hofenacker', canton: 'SH' },
 { name: 'Volkertshausen', ags: '08335081', landkreis: 'Konstanz', lat: 47.821701, lng: 8.869619, population: 3354, plz: '78269', distanceKm: 15.5, nearestCrossing: 'Gottmadingen – Thayngen, Ebringerstrasse', canton: 'SH' },
 { name: 'Gaienhofen', ags: '08335025', landkreis: 'Konstanz', lat: 47.68226, lng: 8.981837, population: 3334, plz: '78343', distanceKm: 9.2, nearestCrossing: 'Öhningen – Stein am Rhein', canton: 'SH' },
 { name: 'Gailingen am Hochrhein', ags: '08335026', landkreis: 'Konstanz', lat: 47.696988, lng: 8.754804, population: 3044, plz: '78262', distanceKm: 0.9, nearestCrossing: 'Diessenhofen – Gailingen am Hochrhein', canton: 'TG' },
 { name: 'Mühlingen', ags: '08335057', landkreis: 'Konstanz', lat: 47.912992, lng: 9.017365, population: 2720, plz: '78357', distanceKm: 34, nearestCrossing: 'Gottmadingen – Thayngen, Ebringerstrasse', canton: 'SH' },
 { name: 'Aach', ags: '08335001', landkreis: 'Konstanz', lat: 47.8428, lng: 8.851043, population: 2377, plz: '78267', distanceKm: 19.9, nearestCrossing: 'Tengen – Thayngen, L188', canton: 'SH' },
 { name: 'Hohenfels', ags: '08335096', landkreis: 'Konstanz', lat: 47.885245, lng: 9.109328, population: 2236, plz: '78355', distanceKm: 36.6, nearestCrossing: 'Gottmadingen – Thayngen, Ebringerstrasse', canton: 'SH' },
 { name: 'Büsingen am Hochrhein', ags: '08335015', landkreis: 'Konstanz', lat: 47.697114, lng: 8.690368, population: 1440, plz: '78266', distanceKm: 1.4, nearestCrossing: 'Büsingen am Hochrhein – Schaffhausen-Stemmer', canton: 'SH' },
 // ── Schwarzwald-Baar-Kreis — 20 comuni ──
 { name: 'Villingen-Schwenningen', ags: '08326074', landkreis: 'Schwarzwald-Baar-Kreis', lat: 48.058255, lng: 8.459649, population: 89756, plz: '78050', distanceKm: 38.1, nearestCrossing: 'Blumberg – Bargen SH, Autostrasse H4', canton: 'SH' },
 { name: 'Donaueschingen', ags: '08326012', landkreis: 'Schwarzwald-Baar-Kreis', lat: 47.951414, lng: 8.497777, population: 21790, plz: '78166', distanceKm: 21.8, nearestCrossing: 'Blumberg – Bargen SH, Autostrasse H4', canton: 'SH' },
 { name: 'Bad Dürrheim', ags: '08326003', landkreis: 'Schwarzwald-Baar-Kreis', lat: 48.022026, lng: 8.530554, population: 13149, plz: '78073', distanceKm: 30.9, nearestCrossing: 'Blumberg – Bargen SH, Autostrasse H4', canton: 'SH' },
 { name: 'St. Georgen im Schwarzwald', ags: '08326052', landkreis: 'Schwarzwald-Baar-Kreis', lat: 48.126225, lng: 8.332259, population: 12301, plz: '78112', distanceKm: 50.4, nearestCrossing: 'Blumberg – Bargen SH, Autostrasse H4', canton: 'SH' },
 { name: 'Blumberg', ags: '08326005', landkreis: 'Schwarzwald-Baar-Kreis', lat: 47.839705, lng: 8.534256, population: 10003, plz: '78176', distanceKm: 8.3, nearestCrossing: 'Blumberg – Bargen SH, Autostrasse H4', canton: 'SH' },
 { name: 'Furtwangen im Schwarzwald', ags: '08326017', landkreis: 'Schwarzwald-Baar-Kreis', lat: 48.051584, lng: 8.205476, population: 8420, plz: '78120', distanceKm: 49.9, nearestCrossing: 'Blumberg – Bargen SH, Autostrasse H4', canton: 'SH' },
 { name: 'Hüfingen', ags: '08326027', landkreis: 'Schwarzwald-Baar-Kreis', lat: 47.9255, lng: 8.488945, population: 8060, plz: '78183', distanceKm: 18.7, nearestCrossing: 'Blumberg – Bargen SH, Autostrasse H4', canton: 'SH' },
 { name: 'Königsfeld im Schwarzwald', ags: '08326031', landkreis: 'Schwarzwald-Baar-Kreis', lat: 48.138624, lng: 8.421452, population: 5960, plz: '78126', distanceKm: 46.5, nearestCrossing: 'Blumberg – Bargen SH, Autostrasse H4', canton: 'SH' },
 { name: 'Niedereschach', ags: '08326041', landkreis: 'Schwarzwald-Baar-Kreis', lat: 48.132561, lng: 8.528615, population: 5857, plz: '78078', distanceKm: 49.1, nearestCrossing: 'Blumberg – Bargen SH, Autostrasse H4', canton: 'SH' },
 { name: 'Bräunlingen', ags: '08326006', landkreis: 'Schwarzwald-Baar-Kreis', lat: 47.930249, lng: 8.448829, population: 5784, plz: '78199', distanceKm: 21.6, nearestCrossing: 'Blumberg – Bargen SH, Autostrasse H4', canton: 'SH' },
 { name: 'Brigachtal', ags: '08326075', landkreis: 'Schwarzwald-Baar-Kreis', lat: 48.016006, lng: 8.470163, population: 5059, plz: '78086', distanceKm: 35.9, nearestCrossing: 'Blumberg – Bargen SH, Autostrasse H4', canton: 'SH' },
 { name: 'Triberg im Schwarzwald', ags: '08326060', landkreis: 'Schwarzwald-Baar-Kreis', lat: 48.128904, lng: 8.231158, population: 4580, plz: '78098', distanceKm: 61, nearestCrossing: 'Blumberg – Bargen SH, Autostrasse H4', canton: 'SH' },
 { name: 'Schonach im Schwarzwald', ags: '08326055', landkreis: 'Schwarzwald-Baar-Kreis', lat: 48.143166, lng: 8.199878, population: 3800, plz: '78136', distanceKm: 64, nearestCrossing: 'Blumberg – Bargen SH, Autostrasse H4', canton: 'SH' },
 { name: 'Dauchingen', ags: '08326010', landkreis: 'Schwarzwald-Baar-Kreis', lat: 48.090373, lng: 8.552862, population: 3800, plz: '78083', distanceKm: 38.8, nearestCrossing: 'Blumberg – Bargen SH, Autostrasse H4', canton: 'SH' },
 { name: 'Vöhrenbach', ags: '08326068', landkreis: 'Schwarzwald-Baar-Kreis', lat: 48.045545, lng: 8.304492, population: 3631, plz: '78147', distanceKm: 41.3, nearestCrossing: 'Blumberg – Bargen SH, Autostrasse H4', canton: 'SH' },
 { name: 'Tuningen', ags: '08326061', landkreis: 'Schwarzwald-Baar-Kreis', lat: 48.026202, lng: 8.602088, population: 3292, plz: '78609', distanceKm: 37.7, nearestCrossing: 'Blumberg – Bargen SH, Autostrasse H4', canton: 'SH' },
 { name: 'Mönchweiler', ags: '08326037', landkreis: 'Schwarzwald-Baar-Kreis', lat: 48.101001, lng: 8.429216, population: 2766, plz: '78087', distanceKm: 41.8, nearestCrossing: 'Blumberg – Bargen SH, Autostrasse H4', canton: 'SH' },
 { name: 'Schönwald im Schwarzwald', ags: '08326054', landkreis: 'Schwarzwald-Baar-Kreis', lat: 48.101542, lng: 8.201148, population: 2566, plz: '78141', distanceKm: 61.8, nearestCrossing: 'Blumberg – Bargen SH, Autostrasse H4', canton: 'SH' },
 { name: 'Unterkirnach', ags: '08326065', landkreis: 'Schwarzwald-Baar-Kreis', lat: 48.078557, lng: 8.366416, population: 2466, plz: '78089', distanceKm: 45.1, nearestCrossing: 'Blumberg – Bargen SH, Autostrasse H4', canton: 'SH' },
 { name: 'Gütenbach', ags: '08326020', landkreis: 'Schwarzwald-Baar-Kreis', lat: 48.044875, lng: 8.138596, population: 1025, plz: '78148', distanceKm: 56.1, nearestCrossing: 'Blumberg – Bargen SH, Autostrasse H4', canton: 'SH' },
];
