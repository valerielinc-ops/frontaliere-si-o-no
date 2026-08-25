#!/usr/bin/env node
/**
 * seo-families-tighten.mjs
 *
 * Lower one family's ceiling in `data/seo-defect-families.json`, or print the
 * ledger.
 *
 * This is how a ratchet actually descends. `audit:all` prints the exact
 * invocation whenever a ratcheted family comes in under its ceiling — the
 * measured rate and the run it came from are already in that line, so
 * tightening is a copy-paste and never a guess:
 *
 *   npm run audit:seo-families -- --list
 *   npm run audit:seo-families:tighten -- --family=<name> --rate=<pct> --run=<run-id>
 *
 * Raising is refused by `tightenLedger()` unless `--allow-raise` is passed, and
 * a raise leaves `raised: true` plus `previousCeilingRatePct` in the entry, so
 * one shows up in review instead of reading like a routine rebaseline. That is
 * the difference between this and the `:rebaseline` scripts elsewhere in
 * package.json, which happily overwrite in either direction.
 */

import { LEDGER_PATH, readLedger, resolveLedgerPath, tightenLedger, writeLedger } from './lib/seoDefectRatchet.mjs';

const args = process.argv.slice(2);
const getArg = (name) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  return idx === -1 ? undefined : args[idx + 1];
};

const ledgerPath = getArg('ledger') ?? LEDGER_PATH;
const ledger = readLedger(ledgerPath);

if (args.includes('--list') || args.length === 0) {
  console.log(`SEO defect families — ${resolveLedgerPath(ledgerPath)}`);
  console.log('');
  for (const [name, e] of Object.entries(ledger.families)) {
    const ceiling = e.enforcement === 'ratchet' ? `${e.ceilingRatePct} %` : '—';
    const seen = e.measurement?.observedOffenders;
    const obs = Array.isArray(seen) ? ` observed=[${seen.join(', ')}]` : '';
    console.log(`  ${name.padEnd(34)} ${String(e.enforcement).padEnd(18)} ceiling=${ceiling.padEnd(12)} ${e.status ?? ''}${obs}`);
    console.log(`  ${' '.repeat(34)} gate=${e.gate}  issue=${e.issue}`);
    if (e.blocker) console.log(`  ${' '.repeat(34)} BLOCKED: ${e.blocker.split('. ')[0]}.`);
    console.log('');
  }
  process.exit(0);
}

const family = getArg('family');
const rate = Number(getArg('rate'));
const runId = getArg('run');

if (!family || !runId || !Number.isFinite(rate)) {
  console.error('usage: node scripts/seo-families-tighten.mjs --family=<name> --rate=<pct> --run=<run-id> [--allow-raise]');
  console.error('       node scripts/seo-families-tighten.mjs --list');
  process.exit(2);
}

const before = ledger.families[family]?.ceilingRatePct;
let next;
try {
  next = tightenLedger({
    ledger,
    family,
    ratePct: rate,
    allowRaise: args.includes('--allow-raise'),
    provenance: {
      runId,
      measuredAt: new Date().toISOString().slice(0, 10),
      filesScanned: Number(getArg('files')) || undefined,
      sampleRate: Number(getArg('sample-rate')) || undefined,
      observedOffenders: Number(getArg('offenders')) || undefined,
    },
  });
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}

writeLedger(next, ledgerPath);
console.log(`✅ ${family}: ceiling ${before} % → ${rate} % (run ${runId})`);
console.log(`   ${resolveLedgerPath(ledgerPath)}`);
