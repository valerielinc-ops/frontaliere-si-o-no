#!/usr/bin/env node
/**
 * Re-apply the expired-route invariant to one candidate archive slice.
 *
 * A crawler can pass a clean slice to git-commit-data.sh while another writer
 * changes the same slice after the checkout. The 3-way merge is keyed by the
 * current slug, not by the locale routes served by an expired entry, so the
 * merged candidate needs the same route collapse that the archive writers use
 * before it is staged.
 */
import fs from 'node:fs';
import { collapseDuplicateRouteEntries, localeRouteKeys } from '../lib/expired-jobs-archive.mjs';
import { writeJsonAtomic } from '../lib/atomic-write-json.mjs';

const [filePath, label = filePath] = process.argv.slice(2);

if (!filePath) {
  console.error('usage: canonicalize-expired-archive-slice.mjs <file> [label]');
  process.exit(2);
}

function routeSet(entries) {
  return new Set(entries.flatMap((entry) => [...localeRouteKeys(entry)]));
}

try {
  const original = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(original)) {
    throw new Error(`${label} must be a JSON array`);
  }

  const result = collapseDuplicateRouteEntries(original, {
    source: `git-commit-data/${label}`,
  });

  // A cap refusal is an explicit decision to leave that component untouched.
  // Only persist a candidate when the shared primitive actually collapsed a
  // route component; this mirrors sweepExpiredArchiveSlices' fail-closed
  // handling and avoids turning a refused component into a sorted rewrite.
  if (result.collapsed === 0) {
    process.exit(0);
  }

  const requiredRoutes = routeSet(original);
  const actualRoutes = routeSet(result.entries);
  const missingRoutes = [...requiredRoutes].filter((route) => !actualRoutes.has(route));
  if (missingRoutes.length > 0) {
    throw new Error(
      `${label} route collapse lost ${missingRoutes.length} route(s): ${missingRoutes.slice(0, 5).join(', ')}`,
    );
  }

  writeJsonAtomic(filePath, result.entries);
  console.log(
    `  🔁 canonicalized expired archive slice ${label}: `
      + `${result.collapsed} duplicate route(s) collapsed`,
  );
} catch (error) {
  console.error(`❌ Could not canonicalize expired archive slice ${label}: ${error.message}`);
  process.exit(1);
}
