#!/usr/bin/env node
/**
 * Prospector · diagnosi del gate PROMOTE, in sola lettura (#9680).
 *
 * Riproduce la decisione dello stadio PROMOTE sullo snapshot versionato dei
 * candidati, con le soglie di produzione (`GATE_DEFAULTS`: `minRuns` e
 * `minDistinctDays` compresi, niente `--min-days=1`), e stampa la partizione
 * stabilita'/altre condizioni con l'attribuzione per predicato dei blocchi
 * `other`. Non scrive niente: ne' `candidates.json`, ne' branch, ne' PR.
 *
 * Exit code:
 *   0 — ogni blocco `other` ha almeno un check fallito e una ragione;
 *   1 — almeno un blocco `other` e' privo di causa concreta (`unattributed`);
 *   2 — il file dei candidati manca o e' illeggibile. Non si ripiega su uno
 *       store vuoto: in un worktree sparse `data/` puo' non essere
 *       materializzato, e "0 bloccati" non deve sembrare una misura.
 *
 * Uso:
 *   node scripts/prospect-promote-diagnosis.mjs
 *   node scripts/prospect-promote-diagnosis.mjs --candidates=<file> --root=<dir>
 */
import fs from 'node:fs';
import { byStatus, loadCandidates } from './lib/prospector/candidate-store.mjs';
import { loadCoverage } from './lib/prospector/coverage.mjs';
import { CANDIDATES_PATH, ROOT } from './lib/prospector/config.mjs';
import {
  selectForPromotion,
  diagnosePromotionBlocks,
  GATE_DEFAULTS,
} from './lib/prospector/promotion-gate.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const candidatesPath = arg('candidates', CANDIDATES_PATH);
const root = arg('root', ROOT);

let raw;
try {
  raw = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
} catch (err) {
  console.error(`candidati illeggibili (${candidatesPath}): ${err.message}`);
  process.exit(2);
}
if (!raw || typeof raw !== 'object' || !raw.candidates) {
  console.error(`candidati senza campo "candidates" (${candidatesPath})`);
  process.exit(2);
}

// Validato sopra: da qui `loadCandidates` non puo' ripiegare sullo store vuoto.
const store = loadCandidates(candidatesPath);
const graduated = byStatus(store, 'promoted');
const gate = {
  maxPerRun: GATE_DEFAULTS.maxPerRun,
  minRuns: GATE_DEFAULTS.minRuns,
  minDistinctDays: GATE_DEFAULTS.minDistinctDays,
};
const { promotable, blocked, capped } = selectForPromotion(
  graduated,
  { existingKeys: loadCoverage(root).keys },
  gate,
);
const diagnosis = diagnosePromotionBlocks(blocked);

console.log(JSON.stringify({
  gate: { minRuns: gate.minRuns, minDistinctDays: gate.minDistinctDays },
  promoted: graduated.length,
  promotable: promotable.length + capped,
  blocked: blocked.length,
  ...diagnosis,
}, null, 2));

process.exit(diagnosis.unattributed.length ? 1 : 0);
