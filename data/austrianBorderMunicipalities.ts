/**
 * austrianBorderMunicipalities.ts — raw candidate dataset for the per-comune
 * AUSTRIA border pages (issue #4883, fourth of the FR/DE/AT/LI rollout after
 * France #4545/#4878, Germany #4882, Liechtenstein #4884).
 *
 * Analogous to data/germanBorderMunicipalities.ts / data/liechtensteinMunicipalities.ts:
 * a hand-maintained flat literal array, one object per line, parsed by
 * scripts/build-austrian-border-municipalities.mjs to derive
 * data/austrian-border-municipalities.json (above/below-floor split applied
 * there, NOT stored here — this file is the raw candidate list only).
 *
 * CANDIDATE UNIVERSE (deliberately NOT the `foreignSide` of data/borderCrossings.ts)
 * -------------------------------------------------------------------------
 * The 11 AT rows in data/borderCrossings.ts (`country: 'AT'`) cover only the
 * documented VEHICULAR crossings and their `foreignSide` names — at most 10
 * distinct towns, several of them fractions (e.g. "Lustenau (Wiesenrain)",
 * "Lustenau (Schmitter)" are the same comune, "Nauders / Pfunds" mixes two).
 * That undercounts by 2.4x: the real number of Austrian Gemeinden whose
 * territory actually touches the Swiss or Liechtenstein border is 24, several
 * of which (the Montafon and Paznaun valleys — Brand, Vandans, Tschagguns,
 * St. Gallenkirch, Gaschurn, Galtür, Ischgl, Kappl, See) border Switzerland
 * over a roadless alpine ridge with NO vehicular crossing nearby (the
 * historical foot passes — Schlappiner Joch, Zeblasjoch, Futschöl,
 * Samnaun-Ischgl/Idjoch — are seasonal/pedestrian-only and deliberately
 * excluded from data/borderCrossings.ts). Each of the 24 comuni below was
 * therefore verified INDIVIDUALLY as border-touching — not derived from
 * `foreignSide` — via its own German Wikipedia article's "Nachbargemeinden"
 * (neighbouring municipalities) list, checking for at least one Swiss (SG or
 * GR) or Liechtenstein comune among its direct neighbours. Full research
 * trail: issue #4883 research doc (24/24 comuni cross-validated this way).
 *
 * SOURCES (verified 2026-07-29)
 * -------------------------------------------------------------------------
 * - name / gkz / bezirk / land: official primary registries —
 *   Vorarlberg (17 comuni): Land Vorarlberg open-data CSV
 *   `https://data.vorarlberg.gv.at/katalog/regionen/regsta_vbg_gemeinden_regionale_gliederung.csv`
 *   Tirol/Landeck (7 comuni): Statistik Austria nationwide Gemeinde list
 *   `https://www.statistik.at/verzeichnis/reglisten/gemliste_knz.pdf` (Gebietsstand 2026)
 * - population / lat / lng: the comune's own German Wikipedia infobox
 *   (`https://de.wikipedia.org/wiki/<Name>`), "Bevölkerung Stand 1. Jänner
 *   2026" relayed with explicit attribution to Statistik Austria — VERIFIED
 *   SECONDARY tier (no free machine-readable per-Gemeinde Statistik Austria
 *   OGD dataset was found; the `OGD_bevjahresanf_PR_BEVJA_4` dataset tried
 *   returned only a national age/year/sex series, not per-Gemeinde —
 *   abandoned, see research doc). `populationDate` is the same for every row:
 *   2026-01-01.
 * - `source` per row: concatenates the GKZ primary source with the
 *   population/coordinate secondary source (Wikipedia), because — unlike the
 *   German twin, which draws every field from one single Destatis extract —
 *   this dataset genuinely mixes a primary official registry (GKZ/bezirk/land)
 *   with a secondary relay (population/coordinates), and the two need to stay
 *   distinguishable per row rather than collapsed into one uniform constant.
 * - distanceKm / nearestCrossing / canton: OSRM public routing server
 *   (router.project-osrm.org, /table/v1/driving endpoint), REAL road-routing
 *   distance from each comune's centroid to the nearest of the 11 AT-country
 *   entries in data/borderCrossings.ts — same method as the German twin.
 *   INFORMATIONAL ONLY here, see FLOOR note below for why it does not gate.
 *
 * FLOOR (deliberately population-only — does NOT transplant the German
 * population-AND-distance floor)
 * -------------------------------------------------------------------------
 * The German floor (population >= 5000 AND OSRM distanceKm <= 20) assumes a
 * dense, evenly-spaced set of vehicular crossings, so "far from any crossing"
 * is a reasonable proxy for "far from the border". That assumption breaks
 * for Austria: the OSRM run for this dataset found Nenzing (population 6502,
 * genuinely border-touching against Graubünden per its own Wikipedia
 * Nachbargemeinden list) at 25.7 km real road distance from the nearest AT
 * vehicular crossing (Montlingen-Koblach) — ABOVE a naive 20 km cutoff —
 * purely because the Vorarlberg/Graubünden border there runs over the
 * roadless Naafkopf ridge with no crossing anywhere near it. Applying the
 * German-style distance gate here would incorrectly demote comuni that
 * really do sit on the border. The floor for this dataset is therefore
 * POPULATION-ONLY (population >= 5000, same threshold as France/Germany),
 * matching the Liechtenstein twin's precedent of a population-only floor
 * where a distance filter would not discriminate meaningfully — see
 * scripts/build-austrian-border-municipalities.mjs for the exact logic.
 * distanceKm / nearestCrossing / canton are still carried per row as
 * informational metadata (e.g. for a future "km dal valico più vicino"
 * content line), just not used to compute aboveFloor/belowFloor.
 *
 * REGIME (fiscal mechanism — DECISIVE FACT, uniform across every row)
 * -------------------------------------------------------------------------
 * Unlike Germany (Art. 15a DBA-D/CH, 4.5% capped Quellensteuer) or
 * Liechtenstein (exclusive residence-state taxation), Austria's special
 * frontalieri regime under Art. 15 §4 of the 30.1.1974 Switzerland-Austria
 * tax treaty (DBA-A, SR 0.672.916.31) was ABROGATED by the 21.3.2006
 * amending protocol (BGBl. III Nr. 22/2007). Since 2006/2007:
 *   - NO special/reduced rate: ordinary cantonal Quellensteuer tariffs apply
 *     under Art. 15 §1 (the pre-2006 reduced rates — 1% until 1995, then 3%
 *     — no longer exist).
 *   - NO defined border zone (Art. 15 §4 was the clause that defined one;
 *     with it gone, Art. 15 §1/§2 applies to ANY Austria-resident working in
 *     Switzerland, regardless of distance from the border).
 *   - NO non-return-day threshold comparable to Germany's 60 days or
 *     Liechtenstein's 45 days — there is no frontaliere status left to lose.
 *     The only day-count in Art. 15 is the general OECD 183-day short-stay
 *     exception (§2), unrelated to border-commuter status.
 *   - Austria avoids double taxation via the CREDIT method (Anrechnungsmethode,
 *     Art. 23 §2) for this income specifically — a deliberate departure from
 *     the exemption-with-progression method (Befreiungsmethode) Austria uses
 *     as its general rule (Art. 23 §1) for other foreign income.
 *   - Instead of an individual tax break, Switzerland pays Austria an
 *     inter-state compensation: 12.5% of the Swiss source-tax revenue from
 *     Art. 15 §1 income, funded by ALL Swiss cantons (not just the
 *     AT-bordering ones) — Final Protocol point 4.
 *   - Home-office/telework: social-security threshold 49.9% of working time
 *     in the residence state (Austria) before the EU/EFTA multilateral
 *     framework agreement (Art. 16(1) Reg. 883/2004) shifts coverage there —
 *     both AT and CH signed effective 2023-07-01. NO bilateral fiscal
 *     telework tolerance agreement (unlike France's 40%/year or Italy's 25%)
 *     was found for Austria — absence of evidence, not confirmed absence.
 * See scripts/build-austrian-border-municipalities.mjs for the REGIME
 * constant and the full source citations (SR 0.672.916.31 consolidated text,
 * Swiss Federal Council report to Parliament 15.11.2013).
 *
 * NOT INCLUDED (deliberately)
 * -------------------------------------------------------------------------
 * - The number of AT->CH frontalieri: only a VERIFIED SECONDARY estimate
 *   (~9'000, mysalario.ch, no direct link to an official BFS table) exists —
 *   not anchored to a published official table, so it is NOT carried as data
 *   anywhere in this dataset or its builder/JSON output (per explicit
 *   instruction: not publishable as a figure). Do not add it later without a
 *   verified primary source.
 * - avgRentMonthly / rent fields: no Austria-specific rent source has been
 *   researched yet — omitted rather than fabricated, same rationale as the
 *   German twin.
 */

export interface AustrianBorderMunicipalityRaw {
  name: string;
  /** Gemeindekennziffer — 5-digit official Austrian municipality code. */
  gkz: string;
  bezirk: 'Bregenz' | 'Dornbirn' | 'Feldkirch' | 'Bludenz' | 'Landeck';
  land: 'Vorarlberg' | 'Tirol';
  lat: number;
  lng: number;
  /** Wikipedia-relayed Statistik Austria population, "Stand 1. Jänner 2026". */
  population: number;
  /** ISO date this population figure is stated as of — same for every row. */
  populationDate: string;
  /** OSRM real road-routing distance (km) to the nearest AT crossing in
   *  data/borderCrossings.ts — informational only, does NOT gate the floor
   *  (see FLOOR note above). */
  distanceKm: number;
  nearestCrossing: string;
  /** Swiss canton of the nearest crossing — geographic/informational only. */
  canton: 'SG' | 'GR';
  /** Per-row provenance (GKZ primary source + population/coordinate secondary source). */
  source: string;
}

export const AUSTRIAN_BORDER_MUNICIPALITIES: AustrianBorderMunicipalityRaw[] = [
 // ── Vorarlberg — 17 comuni (Bezirke Bregenz, Dornbirn, Feldkirch, Bludenz) ──
 { name: 'Gaißau', gkz: '80214', bezirk: 'Bregenz', land: 'Vorarlberg', lat: 47.466111, lng: 9.5975, population: 1894, populationDate: '2026-01-01', distanceKm: 0.1, nearestCrossing: 'Rheineck-Gaißau', canton: 'SG', source: 'https://data.vorarlberg.gv.at/katalog/regionen/regsta_vbg_gemeinden_regionale_gliederung.csv (GKZ); https://de.wikipedia.org/wiki/Gaißau (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten)' },
 { name: 'Höchst', gkz: '80217', bezirk: 'Bregenz', land: 'Vorarlberg', lat: 47.461111, lng: 9.633333, population: 8592, populationDate: '2026-01-01', distanceKm: 3.7, nearestCrossing: 'Rheineck-Gaißau', canton: 'SG', source: 'https://data.vorarlberg.gv.at/katalog/regionen/regsta_vbg_gemeinden_regionale_gliederung.csv (GKZ); https://de.wikipedia.org/wiki/Höchst_(Vorarlberg) (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten)' },
 { name: 'Fußach', gkz: '80213', bezirk: 'Bregenz', land: 'Vorarlberg', lat: 47.478333, lng: 9.663889, population: 4057, populationDate: '2026-01-01', distanceKm: 6.7, nearestCrossing: 'Au-Lustenau', canton: 'SG', source: 'https://data.vorarlberg.gv.at/katalog/regionen/regsta_vbg_gemeinden_regionale_gliederung.csv (GKZ); https://de.wikipedia.org/wiki/Fußach (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten)' },
 { name: 'Lustenau', gkz: '80303', bezirk: 'Dornbirn', land: 'Vorarlberg', lat: 47.4271, lng: 9.671139, population: 24704, populationDate: '2026-01-01', distanceKm: 2.5, nearestCrossing: 'Au-Lustenau', canton: 'SG', source: 'https://data.vorarlberg.gv.at/katalog/regionen/regsta_vbg_gemeinden_regionale_gliederung.csv (GKZ); https://de.wikipedia.org/wiki/Lustenau (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten)' },
 { name: 'Hohenems', gkz: '80302', bezirk: 'Dornbirn', land: 'Vorarlberg', lat: 47.366667, lng: 9.666667, population: 17668, populationDate: '2026-01-01', distanceKm: 4.6, nearestCrossing: 'Diepoldsau-Hohenems', canton: 'SG', source: 'https://data.vorarlberg.gv.at/katalog/regionen/regsta_vbg_gemeinden_regionale_gliederung.csv (GKZ); https://de.wikipedia.org/wiki/Hohenems (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten)' },
 { name: 'Altach', gkz: '80401', bezirk: 'Feldkirch', land: 'Vorarlberg', lat: 47.35, lng: 9.65, population: 7159, populationDate: '2026-01-01', distanceKm: 5, nearestCrossing: 'Kriessern-Mäder', canton: 'SG', source: 'https://data.vorarlberg.gv.at/katalog/regionen/regsta_vbg_gemeinden_regionale_gliederung.csv (GKZ); https://de.wikipedia.org/wiki/Altach (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten)' },
 { name: 'Mäder', gkz: '80412', bezirk: 'Feldkirch', land: 'Vorarlberg', lat: 47.35, lng: 9.616667, population: 4282, populationDate: '2026-01-01', distanceKm: 2.5, nearestCrossing: 'Kriessern-Mäder', canton: 'SG', source: 'https://data.vorarlberg.gv.at/katalog/regionen/regsta_vbg_gemeinden_regionale_gliederung.csv (GKZ); https://de.wikipedia.org/wiki/Mäder (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten)' },
 { name: 'Koblach', gkz: '80410', bezirk: 'Feldkirch', land: 'Vorarlberg', lat: 47.333333, lng: 9.6, population: 5003, populationDate: '2026-01-01', distanceKm: 1, nearestCrossing: 'Montlingen-Koblach', canton: 'SG', source: 'https://data.vorarlberg.gv.at/katalog/regionen/regsta_vbg_gemeinden_regionale_gliederung.csv (GKZ); https://de.wikipedia.org/wiki/Koblach (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten; Nachbargemeinde Oberriet/SG bestätigt Grenzlage)' },
 { name: 'Meiningen', gkz: '80413', bezirk: 'Feldkirch', land: 'Vorarlberg', lat: 47.3, lng: 9.583333, population: 2546, populationDate: '2026-01-01', distanceKm: 5.6, nearestCrossing: 'Montlingen-Koblach', canton: 'SG', source: 'https://data.vorarlberg.gv.at/katalog/regionen/regsta_vbg_gemeinden_regionale_gliederung.csv (GKZ); https://de.wikipedia.org/wiki/Meiningen_(Vorarlberg) (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten; Nachbargemeinde Oberriet/SG bestätigt Grenzlage)' },
 { name: 'Feldkirch', gkz: '80404', bezirk: 'Feldkirch', land: 'Vorarlberg', lat: 47.238056, lng: 9.598333, population: 36643, populationDate: '2026-01-01', distanceKm: 11, nearestCrossing: 'Rüthi-Meiningen', canton: 'SG', source: 'https://data.vorarlberg.gv.at/katalog/regionen/regsta_vbg_gemeinden_regionale_gliederung.csv (GKZ); https://de.wikipedia.org/wiki/Feldkirch (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten)' },
 { name: 'Frastanz', gkz: '80405', bezirk: 'Feldkirch', land: 'Vorarlberg', lat: 47.22, lng: 9.62, population: 6673, populationDate: '2026-01-01', distanceKm: 14.4, nearestCrossing: 'Rüthi-Meiningen', canton: 'SG', source: 'https://data.vorarlberg.gv.at/katalog/regionen/regsta_vbg_gemeinden_regionale_gliederung.csv (GKZ); https://de.wikipedia.org/wiki/Frastanz (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten; Nachbargemeinden Mauren/Eschen/Planken/Schaan/Balzers/FL bestätigt Grenzlage zu Liechtenstein)' },
 { name: 'Nenzing', gkz: '80116', bezirk: 'Bludenz', land: 'Vorarlberg', lat: 47.185556, lng: 9.704167, population: 6502, populationDate: '2026-01-01', distanceKm: 25.7, nearestCrossing: 'Montlingen-Koblach', canton: 'SG', source: 'https://data.vorarlberg.gv.at/katalog/regionen/regsta_vbg_gemeinden_regionale_gliederung.csv (GKZ); https://de.wikipedia.org/wiki/Nenzing (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten; Nachbargemeinden Balzers/Schaan/Triesenberg/FL + Maienfeld/Seewis/GR bestätigt Grenzlage zu Liechtenstein und Schweiz)' },
 { name: 'Brand', gkz: '80105', bezirk: 'Bludenz', land: 'Vorarlberg', lat: 47.103889, lng: 9.737778, population: 736, populationDate: '2026-01-01', distanceKm: 42.3, nearestCrossing: 'Montlingen-Koblach', canton: 'SG', source: 'https://data.vorarlberg.gv.at/katalog/regionen/regsta_vbg_gemeinden_regionale_gliederung.csv (GKZ); https://de.wikipedia.org/wiki/Brand_(Vorarlberg) (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten; Nachbarregion Prättigau/Davos/GR bestätigt Grenzlage, Schesaplana als Grenzgipfel)' },
 { name: 'Vandans', gkz: '80129', bezirk: 'Bludenz', land: 'Vorarlberg', lat: 47.095278, lng: 9.865556, population: 2847, populationDate: '2026-01-01', distanceKm: 42.1, nearestCrossing: 'Montlingen-Koblach', canton: 'SG', source: 'https://data.vorarlberg.gv.at/katalog/regionen/regsta_vbg_gemeinden_regionale_gliederung.csv (GKZ); https://de.wikipedia.org/wiki/Vandans (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten; Nachbargemeinden Seewis im Prättigau/Schiers/GR bestätigt Grenzlage)' },
 { name: 'Tschagguns', gkz: '80128', bezirk: 'Bludenz', land: 'Vorarlberg', lat: 47.076667, lng: 9.900833, population: 2232, populationDate: '2026-01-01', distanceKm: 45.6, nearestCrossing: 'Montlingen-Koblach', canton: 'SG', source: 'https://data.vorarlberg.gv.at/katalog/regionen/regsta_vbg_gemeinden_regionale_gliederung.csv (GKZ); https://de.wikipedia.org/wiki/Tschagguns (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten; Nachbargemeinden Schiers/Luzein/GR bestätigt Grenzlage)' },
 { name: 'St. Gallenkirch', gkz: '80120', bezirk: 'Bludenz', land: 'Vorarlberg', lat: 47.020278, lng: 9.974167, population: 2237, populationDate: '2026-01-01', distanceKm: 54.1, nearestCrossing: 'Montlingen-Koblach', canton: 'SG', source: 'https://data.vorarlberg.gv.at/katalog/regionen/regsta_vbg_gemeinden_regionale_gliederung.csv (GKZ); https://de.wikipedia.org/wiki/St._Gallenkirch (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten; Nachbargemeinden Luzein/Klosters/GR bestätigt Grenzlage)' },
 { name: 'Gaschurn', gkz: '80110', bezirk: 'Bludenz', land: 'Vorarlberg', lat: 46.98816, lng: 10.02544, population: 1543, populationDate: '2026-01-01', distanceKm: 59.6, nearestCrossing: 'Montlingen-Koblach', canton: 'SG', source: 'https://data.vorarlberg.gv.at/katalog/regionen/regsta_vbg_gemeinden_regionale_gliederung.csv (GKZ); https://de.wikipedia.org/wiki/Gaschurn (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten; Nachbargemeinden Klosters/Zernez/Scuol/GR bestätigt Grenzlage)' },
 // ── Tirol, Bezirk Landeck — 7 comuni ──
 { name: 'Galtür', gkz: '70606', bezirk: 'Landeck', land: 'Tirol', lat: 46.968333, lng: 10.187222, population: 799, populationDate: '2026-01-01', distanceKm: 79.9, nearestCrossing: 'Martina-Nauders (Finstermünz)', canton: 'GR', source: 'https://www.statistik.at/verzeichnis/reglisten/gemliste_knz.pdf (GKZ, Gebietsstand 2026); https://de.wikipedia.org/wiki/Galtür (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten)' },
 { name: 'Ischgl', gkz: '70608', bezirk: 'Landeck', land: 'Tirol', lat: 47.013056, lng: 10.288056, population: 1624, populationDate: '2026-01-01', distanceKm: 71.1, nearestCrossing: 'Martina-Nauders (Finstermünz)', canton: 'GR', source: 'https://www.statistik.at/verzeichnis/reglisten/gemliste_knz.pdf (GKZ, Gebietsstand 2026); https://de.wikipedia.org/wiki/Ischgl (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten)' },
 { name: 'Kappl', gkz: '70609', bezirk: 'Landeck', land: 'Tirol', lat: 47.063056, lng: 10.375556, population: 2527, populationDate: '2026-01-01', distanceKm: 62, nearestCrossing: 'Martina-Nauders (Finstermünz)', canton: 'GR', source: 'https://www.statistik.at/verzeichnis/reglisten/gemliste_knz.pdf (GKZ, Gebietsstand 2026); https://de.wikipedia.org/wiki/Kappl_(Tirol) (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten)' },
 { name: 'See', gkz: '70623', bezirk: 'Landeck', land: 'Tirol', lat: 47.0833, lng: 10.4667, population: 1242, populationDate: '2026-01-01', distanceKm: 54.4, nearestCrossing: 'Martina-Nauders (Finstermünz)', canton: 'GR', source: 'https://www.statistik.at/verzeichnis/reglisten/gemliste_knz.pdf (GKZ, Gebietsstand 2026); https://de.wikipedia.org/wiki/See_(Gemeinde) (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten)' },
 { name: 'Spiss', gkz: '70625', bezirk: 'Landeck', land: 'Tirol', lat: 46.959167, lng: 10.431389, population: 97, populationDate: '2026-01-01', distanceKm: 7.8, nearestCrossing: 'Samnaun-Spiss', canton: 'GR', source: 'https://www.statistik.at/verzeichnis/reglisten/gemliste_knz.pdf (GKZ, Gebietsstand 2026); https://de.wikipedia.org/wiki/Spiss_(Tirol) (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten)' },
 { name: 'Pfunds', gkz: '70617', bezirk: 'Landeck', land: 'Tirol', lat: 46.967778, lng: 10.541389, population: 2610, populationDate: '2026-01-01', distanceKm: 13.2, nearestCrossing: 'Martina-Nauders (Finstermünz)', canton: 'GR', source: 'https://www.statistik.at/verzeichnis/reglisten/gemliste_knz.pdf (GKZ, Gebietsstand 2026); https://de.wikipedia.org/wiki/Pfunds (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten)' },
 { name: 'Nauders', gkz: '70615', bezirk: 'Landeck', land: 'Tirol', lat: 46.8925, lng: 10.503889, population: 1559, populationDate: '2026-01-01', distanceKm: 8.6, nearestCrossing: 'Martina-Nauders (Finstermünz)', canton: 'GR', source: 'https://www.statistik.at/verzeichnis/reglisten/gemliste_knz.pdf (GKZ, Gebietsstand 2026); https://de.wikipedia.org/wiki/Nauders (Bevölkerung Stand 1.1.2026 rel. Statistik Austria; Koordinaten)' },
];
