// Sentence-boundary split that preserves the abbreviation period in Swiss city
// names beginning with "St."/"Ste." (St. Moritz, St. Gallen, Ste. Croix).
//
// A blanket `.split('.')` truncated "St. Moritz" → "St" / "St. Gallen" → "St",
// which then failed the Swiss-municipality whitelist downstream and silently
// dropped every job for those localities from the dataset (PR #1451). This split
// cuts on newline, ";", or any sentence-ending "." EXCEPT a period that directly
// follows a "St"/"Ste" token (variable-length negative lookbehind), so the
// compact city string survives even when surrounding markup runs prose into the
// same node (e.g. "…Switzerland.Availability to work on-site…").
//
// Shared by `alten-job-parser.mjs` and `assemble-jobs-dataset.mjs` so the two
// mirrored cuts cannot drift (AGENTS.md non-negotiable #6: a regex duplicated
// literally in ≥2 files → one shared module).
//
// Execution context (issue #1457): both call sites run in the MAIN Node V8 — the
// parsers pull `page.content()` out of the browser and run `.split()` on a plain
// string, NOT inside `page.evaluate` / a vm sandbox — so the variable-length
// lookbehind is fully supported (Node ≥9 / V8 ≥6.2). Verified on Node 22 against
// St. Moritz / St. Gallen / Ste. Croix.
export const SWISS_LOCALITY_SENTENCE_SPLIT_RX = /[\n;]|(?<!\bSte?)\./;
