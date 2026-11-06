// Sentence-boundary split that preserves the abbreviation period in Swiss city
// names beginning with "St."/"Ste." (St. Moritz, St. Gallen, Ste. Croix).
//
// A blanket `.split('.')` truncated "St. Moritz" → "St" / "St. Gallen" → "St",
// which then failed the Swiss-municipality whitelist downstream and silently
// dropped every job for those localities from the dataset (PR #1451). The helper
// preserves "St."/"Ste." periods while cutting on newline, ";", and other
// sentence-ending periods. This keeps a city intact when surrounding markup
// runs prose into the same node (e.g. "…Switzerland.Availability to work on-site…").
//
// Shared by `alten-job-parser.mjs` and `assemble-jobs-dataset.mjs` so the two
// mirrored cuts cannot drift (AGENTS.md non-negotiable #6: a regex duplicated
// literally in ≥2 files → one shared module).
//
// The helper checks the short preceding token directly, so it is safe in the
// browser-bundled import graph as well as in the Node parser.
export function splitSwissLocalitySentences(value = '') {
  const text = String(value ?? '');
  const parts = [];
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\n' || char === ';') {
      parts.push(text.slice(start, index));
      start = index + 1;
      continue;
    }
    if (char !== '.') continue;

    const tokenStart = text.slice(index - 3, index) === 'Ste'
      ? index - 3
      : text.slice(index - 2, index) === 'St'
        ? index - 2
        : -1;
    const followsSaintAbbreviation = tokenStart >= 0
      && (tokenStart === 0 || !/\w/.test(text[tokenStart - 1]));
    if (followsSaintAbbreviation) continue;

    parts.push(text.slice(start, index));
    start = index + 1;
  }

  parts.push(text.slice(start));
  return parts;
}
