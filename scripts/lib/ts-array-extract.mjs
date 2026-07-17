// scripts/lib/ts-array-extract.mjs
//
// Tiny regex-based extractor for `export const <NAME> = [ ...string literals... ] as const;`
// TS array literals, read from plain Node (.mjs) scripts that don't want a
// full TS compiler dependency just to read a catalog of ids.
//
// Extracted from scripts/profession-keyword-opportunities.mjs (where it was
// a local, unexported helper) so scripts/mine-search-location-gaps.mjs
// (issue #4301) can reuse the identical parsing instead of forking a second
// copy of the same regex — AGENTS.md non-negotiable #6.

import fs from 'node:fs';

/** Extract quoted string-literal entries from `export const <NAME> = [ ... ];` in a TS file. */
export function extractTsStringArray(filePath, constName) {
  const src = fs.readFileSync(filePath, 'utf-8');
  const m = src.match(new RegExp(`export const ${constName}\\s*=\\s*\\[([^\\]]*)\\]`));
  if (!m) throw new Error(`Cannot find ${constName} in ${filePath}`);
  const body = m[1];
  const items = [];
  const re = /'([^']*)'|"([^"]*)"/g;
  let mm;
  while ((mm = re.exec(body))) {
    items.push(mm[1] ?? mm[2] ?? '');
  }
  return items;
}
