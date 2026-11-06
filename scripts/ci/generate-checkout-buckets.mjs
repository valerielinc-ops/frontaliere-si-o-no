#!/usr/bin/env node
/**
 * Rigenera scripts/ci/checkout-buckets.json misurando l'albero di origin/main.
 *
 * Un "bucket" e' una foglia pesante del checkout che un workflow puo' NON
 * scaricare. La granularita' e' scelta cosi': i percorsi sopra MIN_MB, presi al
 * secondo livello sotto data/ e public/ e come cartella intera altrove.
 *
 * Tutto cio' che resta sotto soglia NON diventa mai un bucket: e' la "coda"
 * (~64 MB su 1'567 file) che ogni checkout tiene sempre. E' quella coda a
 * rendere l'operazione a basso rischio — un file piccolo dimenticato
 * dall'analisi c'e' comunque.
 *
 *   node scripts/ci/generate-checkout-buckets.mjs [--ref origin/main]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ref = process.argv.includes('--ref') ? process.argv[process.argv.indexOf('--ref') + 1] : 'origin/main';
const MIN_MB = 15;
const OUT = path.join(process.cwd(), 'scripts/ci/checkout-buckets.json');

const raw = execFileSync('git', ['ls-tree', '-r', '-l', ref], { maxBuffer: 1 << 30 }).toString();
const files = [];
for (const line of raw.split('\n')) {
  if (!line) continue;
  const m = line.match(/^\S+\s+\S+\s+\S+\s+(\S+)\t(.*)$/);
  if (!m) continue;
  files.push({ size: Number(m[1]) || 0, p: m[2] });
}

/** Il percorso-bucket candidato per un file: 2 livelli sotto data/ e public/, 1 altrove. */
function bucketPathFor(p) {
  const s = p.split('/');
  if (s[0] === 'data' || s[0] === 'public') return s.length > 2 ? `${s[0]}/${s[1]}/` : `${s[0]}/${s[1]}`;
  if (s[0] === 'packages' && s[1] === 'articles') return s.length > 3 ? `packages/articles/${s[2]}/` : null;
  if (s[0] === 'docs') return 'docs/';
  return null;
}

const agg = new Map();
for (const f of files) {
  const b = bucketPathFor(f.p);
  if (!b) continue;
  const cur = agg.get(b) ?? { bytes: 0, files: 0 };
  cur.bytes += f.size; cur.files += 1;
  agg.set(b, cur);
}

const buckets = [...agg.entries()]
  .map(([id, v]) => ({ id, mb: Math.round(v.bytes / 1048576), files: v.files }))
  .filter((b) => b.mb >= MIN_MB)
  .sort((a, b) => b.mb - a.mb);

const treeBytes = files.reduce((a, f) => a + f.size, 0);
const covered = buckets.reduce((a, b) => a + b.mb, 0);
const payload = {
  _comment: 'GENERATO da scripts/ci/generate-checkout-buckets.mjs — non modificare a mano.',
  ref, measuredAt: new Date().toISOString().slice(0, 10), minMb: MIN_MB,
  treeMb: Math.round(treeBytes / 1048576), treeFiles: files.length,
  baselineMb: Math.round(treeBytes / 1048576) - covered,
  buckets,
};
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
console.log(`albero: ${payload.treeMb} MB / ${payload.treeFiles} file`);
console.log(`bucket (>=${MIN_MB} MB): ${buckets.length} — coprono ${covered} MB`);
console.log(`baseline sempre presente: ${payload.baselineMb} MB`);
console.log(`scritto ${path.relative(process.cwd(), OUT)}`);
