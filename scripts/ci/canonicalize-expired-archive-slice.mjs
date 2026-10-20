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
import path from 'node:path';
import { createHash } from 'node:crypto';
import { collapseDuplicateRouteEntries, localeRouteKeys } from '../lib/expired-jobs-archive.mjs';
import { writeJsonAtomic } from '../lib/atomic-write-json.mjs';
import { localeMapKey } from '../lib/locale-map-diff.mjs';

const [filePath, label = filePath, proofPath = ''] = process.argv.slice(2);

if (!filePath) {
  console.error('usage: canonicalize-expired-archive-slice.mjs <file> [label] [proof-path]');
  process.exit(2);
}

function routeSet(entries) {
  return new Set(entries.flatMap((entry) => [...localeRouteKeys(entry)]));
}

function sha256(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function archiveIdentity(entry) {
  const slug = String(entry?.slug ?? '').trim();
  if (slug) return `slug:${String(entry?.companyKey ?? '').trim()}:${slug}`;
  const id = String(entry?.id ?? '').trim();
  if (id) return `id:${id}`;
  return `locale:${localeMapKey(entry?.slugByLocale)}`;
}

function writeRouteProof(proof, targetPath) {
  if (!targetPath) return;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

try {
  const originalRaw = fs.readFileSync(filePath, 'utf8');
  const original = JSON.parse(originalRaw);
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

  const baseIdentities = original.map(archiveIdentity);
  const candidateIdentities = result.entries.map(archiveIdentity);
  const candidateIdentitySet = new Set(candidateIdentities);
  const routeUnion = [...requiredRoutes].sort();
  const predictedCandidateRaw = `${JSON.stringify(result.entries, null, 2)}\n`;
  const routeProof = {
    schemaVersion: 1,
    kind: 'expired-route-collapse',
    path: label,
    baseDigest: sha256(originalRaw),
    candidateDigest: sha256(predictedCandidateRaw),
    baseEntryCount: original.length,
    candidateEntryCount: result.entries.length,
    collapsed: result.collapsed,
    removedIdentities: baseIdentities.filter((identity) => !candidateIdentitySet.has(identity)),
    routeCount: routeUnion.length,
    routeDigest: sha256(JSON.stringify(routeUnion)),
  };

  // The proof is also passed to the local atomic writer. This matters when a
  // route component itself crosses the catastrophic byte floor; the commit
  // helper receives the same proof again after the final merge.
  writeJsonAtomic(filePath, result.entries, {
    housekeepingProof: proofPath ? routeProof : null,
  });
  const candidateRaw = fs.readFileSync(filePath, 'utf8');
  if (proofPath) {
    writeRouteProof({ ...routeProof, candidateDigest: sha256(candidateRaw) }, proofPath);
  }
  console.log(
    `  🔁 canonicalized expired archive slice ${label}: `
      + `${result.collapsed} duplicate route(s) collapsed`,
  );
} catch (error) {
  console.error(`❌ Could not canonicalize expired archive slice ${label}: ${error.message}`);
  process.exit(1);
}
