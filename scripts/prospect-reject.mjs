#!/usr/bin/env node
/**
 * Prospector — respingi un candidato con causa accertata.
 *
 * Gli stadi automatici respingono cio' che sanno misurare (sintesi fallita,
 * voto `bad`, duplicato di un crawler esistente). Restano fuori le spec che
 * estraggono benissimo la cosa SBAGLIATA — identita' del datore diversa da
 * quella dichiarata, aggregatore, pagine di navigazione, annunci esteri — che
 * nessuna metrica del gate sa nominare da sola: quelle restano `promoted` a
 * vita e ogni notte occupano gli slot di validazione (40) che servono ai
 * candidati che possono ancora avanzare, perche' `promoted` non e' in
 * `DONE_STATUSES` (`scripts/prospect-validate.mjs`).
 *
 * Questo comando e' l'unico modo previsto per scrivere quel verdetto: passa da
 * `setStatus` (forward-only, con voce nel registro `ledger.jsonl`) e pretende
 * la causa, cosi' resta verificabile a posteriori perche' quel candidato e'
 * fuori. Modificare `candidates.json` a mano non lascia nessuna delle due
 * tracce.
 *
 * Usage:
 *   node scripts/prospect-reject.mjs <ref>='<causa>' [<ref>='<causa>' ...] [--dry-run]
 *
 *   <ref> = chiave del candidato (`picks.ch`) oppure del crawler (`picks`).
 *
 * Esempio:
 *   node scripts/prospect-reject.mjs \
 *     ibg='identita\' sbagliata: la spec legge zhaw.ch, non IBG Engineering' --dry-run
 */
import { loadCandidates, saveCandidates, statusCounts } from './lib/prospector/candidate-store.mjs';
import { rejectCandidates } from './lib/prospector/reject-candidates.mjs';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');

/** @type {{ ref: string, reason: string }[]} */
const entries = [];
for (const a of argv) {
  if (a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  if (eq <= 0) {
    console.error(`Argomento senza causa: ${a} — serve la forma <ref>='<causa>'`);
    process.exit(2);
  }
  entries.push({ ref: a.slice(0, eq), reason: a.slice(eq + 1) });
}

if (!entries.length) {
  console.error("Usage: node scripts/prospect-reject.mjs <ref>='<causa>' [...] [--dry-run]");
  process.exit(2);
}

const store = loadCandidates();
const { applied, skipped } = rejectCandidates(store, entries);

console.log('═══ Prospector · REJECT ═══');
for (const a of applied) console.log(`  ✗ ${a.key.padEnd(34)} ${a.from} → rejected   ${a.reason}`);
for (const s of skipped) console.log(`  · ${String(s.key || s.ref).padEnd(34)} saltato: ${s.why}`);

if (applied.length && !dryRun) saveCandidates(store);
console.log(`\n${applied.length} respinti${dryRun ? ' (dry-run, niente scritto)' : ''} · ${skipped.length} saltati`);
console.log(`coda: ${JSON.stringify(statusCounts(store))}`);

// Un ref che non risolve e' quasi sempre un refuso, e passare inosservato
// significa credere di aver liberato uno slot che invece resta occupato.
process.exit(skipped.length ? 1 : 0);
