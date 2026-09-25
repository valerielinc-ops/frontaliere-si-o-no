/**
 * liechtensteinMunicipalities.ts — raw candidate dataset for the per-comune
 * LIECHTENSTEIN corridor pages (issue #4884, third of the FR/DE/AT/LI
 * rollout started by #4545).
 *
 * Analogous to data/frenchBorderMunicipalities.ts / data/municipalities.ts:
 * a hand-maintained flat literal array, one object per line (all 11 comuni
 * of Liechtenstein — there is no larger corridor to filter down from, unlike
 * France/Italy), parsed by scripts/build-liechtenstein-municipalities.mjs to
 * derive data/liechtenstein-municipalities.json (above/below-floor split
 * applied there, NOT stored here — this file is the raw candidate list
 * only).
 *
 * EDITORIAL CONTEXT — read before reusing this file for copy
 * -------------------------------------------------------------------------
 * Unlike the France/Italy corridors, the DOMINANT commuting flow on this
 * corridor is Switzerland -> Liechtenstein (14'891 people in 2023), not the
 * reverse (2'426 people, ~6:1 minority) that this site's "vivere a {comune},
 * lavori in Svizzera" template assumes. That direction fact is NOT encoded
 * per-row here (it is national, not per-comune) — see
 * `LIECHTENSTEIN_COMMUTING_CONTEXT` in
 * scripts/build-liechtenstein-municipalities.mjs, which carries it into the
 * emitted JSON so no downstream consumer re-derives or misquotes the figure.
 * Full sourcing trail (fiscal treaty, customs union, social security):
 * see the SOURCES block below — every figure carries its own primary URL.
 *
 * SOURCES (verified 2026-07-29, all primary/official, no paid tool)
 * -------------------------------------------------------------------------
 * - population / populationYear: Amt für Statistik Liechtenstein,
 *   "Statistisches Jahrbuch Liechtensteins 2025" (published 21.03.2025,
 *   updated 02.12.2025), table T_2.1_01 "Bevölkerung nach Wohngemeinde,
 *   1960-2023", p. 75 — https://www.statistikportal.li/statistikportal/
 *   publications/101-statistisches-jahrbuch/2025/01/2/101.2025.01.1_02_statistisches-jahrbuch-2025.pdf
 *   Read and transcribed primary-source by the fiscal research session (see
 *   tax-research-de-li.md, Passo 2 Punto 4); all 11 values sum exactly to
 *   the published national total (40'015 at 31.12.2023) — internal
 *   consistency re-verified again here (see the builder's --stats output).
 *   NO population figure for a year later than 2023 is used: 2025 press
 *   figures circulating for the national total are mutually discordant
 *   (41'237 / 41'024 / 41'722 depending on outlet) per the same research —
 *   none of them is per-comune anyway, so there is nothing usable to update
 *   to even if one were trusted.
 * - lat / lng: Wikidata (query.wikidata.org/sparql), SPARQL query for every
 *   item with `wdt:P31 wd:Q203300` ("municipality of Liechtenstein") and its
 *   `wdt:P625` (coordinate location), retrieved 2026-07-29. Returned exactly
 *   11 items, matching the 11 comuni in the population source above 1:1 by
 *   name. `wikidataId` is kept per-row for audit traceability (re-query
 *   `https://www.wikidata.org/wiki/Special:EntityData/<id>.json` to re-verify
 *   a single coordinate). Coordinates rounded to 4 decimals (~11 m).
 *   Cross-checked for plausibility (not substituted) against the 6 real
 *   Liechtenstein border crossings already in data/borderCrossings.ts: e.g.
 *   Vaduz (47.1406, 9.5222) sits east/uphill of the Sevelen-Vaduz crossing
 *   (47.1206, 9.4869) as expected for a town center vs. a river crossing;
 *   Gamprin (47.2199, 9.5100) is ~1.2 km from the Haag-Bendern crossing
 *   (47.2101, 9.4994) whose foreign side ("Bendern") is a village inside the
 *   Gamprin municipality; the north-to-south latitude ordering of all 11
 *   (Ruggell highest -> Balzers lowest) matches the well-known geography of
 *   the Rhine-valley strip the country occupies. No coordinate was rejected.
 *
 * NOT included, deliberately (see tax-research-de-li.md, "NON pubblicabile")
 * -------------------------------------------------------------------------
 * - No health-insurance Optionsrecht claim — not sourced to an official
 *   Liechtenstein/Swiss primary (llv.li / bag.admin.ch both unreachable in
 *   the research session); not a per-comune fact regardless.
 * - No distanceKm / nearestCrossing field: the France/Italy corridor floor
 *   uses distance-to-border as a proximity filter because those are large
 *   countries with many interior comuni. Liechtenstein is ~160 km^2 total —
 *   every comune is inherently within commuting range of Switzerland, so a
 *   distance filter would not discriminate anything meaningful. The floor
 *   here is population-only (see the builder for the reasoning/numbers).
 */

export interface LiechtensteinMunicipalityRaw {
  name: string;
  /** Wikidata QID, e.g. 'Q1844' for Vaduz — kept for coordinate audit trail. */
  wikidataId: string;
  lat: number;
  lng: number;
  population: number;
  /** Reference date for `population`: this is a year, the full date
   *  (31.12.2023) is documented in the header above and in the builder's
   *  emitted `source` string — not repeated per-row. */
  populationYear: number;
}

export const LIECHTENSTEIN_MUNICIPALITIES: LiechtensteinMunicipalityRaw[] = [
 { name: 'Schaan', wikidataId: 'Q49657', lat: 47.1667, lng: 9.5167, population: 6109, populationYear: 2023 },
 { name: 'Vaduz', wikidataId: 'Q1844', lat: 47.1406, lng: 9.5222, population: 5826, populationYear: 2023 },
 { name: 'Triesen', wikidataId: 'Q49654', lat: 47.1000, lng: 9.5167, population: 5532, populationYear: 2023 },
 { name: 'Balzers', wikidataId: 'Q49663', lat: 47.0667, lng: 9.5000, population: 4747, populationYear: 2023 },
 { name: 'Eschen', wikidataId: 'Q4540', lat: 47.2000, lng: 9.5167, population: 4607, populationYear: 2023 },
 { name: 'Mauren', wikidataId: 'Q49661', lat: 47.2197, lng: 9.5428, population: 4589, populationYear: 2023 },
 { name: 'Triesenberg', wikidataId: 'Q49651', lat: 47.1167, lng: 9.5333, population: 2671, populationYear: 2023 },
 { name: 'Ruggell', wikidataId: 'Q49659', lat: 47.2450, lng: 9.5332, population: 2523, populationYear: 2023 },
 { name: 'Gamprin', wikidataId: 'Q49662', lat: 47.2199, lng: 9.5100, population: 1768, populationYear: 2023 },
 { name: 'Schellenberg', wikidataId: 'Q49655', lat: 47.2283, lng: 9.5395, population: 1155, populationYear: 2023 },
 { name: 'Planken', wikidataId: 'Q49660', lat: 47.1833, lng: 9.5333, population: 488, populationYear: 2023 },
];
