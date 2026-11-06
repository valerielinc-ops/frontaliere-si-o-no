#!/usr/bin/env node
/**
 * Validate the deferred hreflang marker carried beside a non-IT source tar.
 *
 * The publish workflow checks whether this file exists in the source checkout:
 * new producers must carry the marker and are finalized there; older source
 * commits predate the marker and already contain finalized locale artifacts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

export const HREFLANG_FINALIZATION_MARKER = 'same-run-hreflang-rewrite-pending-v1';
export const HREFLANG_FINALIZATION_MARKER_FILE = 'hreflang-finalization-required.txt';

export function validateLocaleSourceHreflangContract(artifactDir) {
  if (!artifactDir) throw new Error('locale source artifact directory is required');
  const markerPath = path.join(artifactDir, HREFLANG_FINALIZATION_MARKER_FILE);
  let marker;
  try {
    marker = fs.readFileSync(markerPath, 'utf8').trim();
  } catch (error) {
    throw new Error(`new locale source artifact is missing ${HREFLANG_FINALIZATION_MARKER_FILE}`, { cause: error });
  }
  if (marker !== HREFLANG_FINALIZATION_MARKER) {
    throw new Error(`unsupported locale source hreflang marker: ${JSON.stringify(marker)}`);
  }
  return 'pending';
}

if (isInvokedDirectly(import.meta.url)) {
  const artifactDir = process.argv[2];
  try {
    process.stdout.write(`${validateLocaleSourceHreflangContract(artifactDir)}\n`);
  } catch (error) {
    console.error(`[locale-source-hreflang-contract] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
