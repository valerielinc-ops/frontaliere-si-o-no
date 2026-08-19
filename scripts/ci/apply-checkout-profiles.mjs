#!/usr/bin/env node
/**
 * Scrive nei workflow lo sparse-checkout calcolato da checkout-profile-analyzer.mjs.
 *
 * Perche' l'inserimento e' testuale e non via YAML.stringify: un round-trip del
 * pacchetto `yaml` riscrive 88 dei 204 workflow (virgolette, larghezza righe,
 * blocchi). Sarebbe un diff illeggibile su file di produzione. Qui si inseriscono
 * solo le righe nuove e si VERIFICA dopo, confrontando gli alberi YAML parsati,
 * che l'unica differenza siano le chiavi aggiunte.
 *
 *   node scripts/ci/apply-checkout-profiles.mjs [--dry-run] [--only <file.yml>]
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { analyzeWorkflow, BUCKETS, TREE_MB, ROOT } from './checkout-profile-analyzer.mjs';

const WF_DIR = path.join(ROOT, '.github/workflows');
const DRY = process.argv.includes('--dry-run');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const MARK = '# checkout sparse: generato da scripts/ci/apply-checkout-profiles.mjs';

/** Righe dei pattern sparse per una lista di bucket da escludere. */
export function sparsePatterns(exclude) {
  return ['/*', ...exclude.map((id) => '!/' + id)];
}

/**
 * Inserisce `sparse-checkout` nel passo di checkout del job dato.
 *
 * Ritorna `{ text, status }`:
 *   - `patched`  blocco inserito o aggiornato;
 *   - `manual`   il passo ha gia' uno sparse-checkout scritto a mano → NON si
 *                tocca. Alcuni sono piu' snelli di quanto questo script sappia
 *                produrre (`measure-deploy-delta.yml` si porta giu' un solo file
 *                .py), e sovrascriverli sarebbe una regressione;
 *   - `nostep`   nessun passo di checkout in questo job.
 *
 * Il blocco viene ACCODATO in fondo al `with:` esistente, non anteposto: cosi'
 * le chiavi gia' presenti (`fetch-depth`, `token`, e i commenti inline attaccati
 * a esse) restano dove sono e il diff resta leggibile.
 */
export function patchJobCheckout(text, jobId, patterns) {
  const lines = text.split('\n');
  const doc = YAML.parseDocument(text);
  const steps = doc.getIn(['jobs', jobId, 'steps'], true);
  if (!steps?.items) return { text, status: 'nostep' };

  let stepNode = null;
  for (const it of steps.items) {
    const uses = it?.get?.('uses');
    if (typeof uses === 'string' && uses.startsWith('actions/checkout@')) { stepNode = it; break; }
  }
  if (!stepNode) return { text, status: 'nostep' };

  const usesPair = stepNode.items.find((p) => String(p.key) === 'uses');
  const usesLine = text.slice(0, usesPair.key.range[0]).split('\n').length - 1;
  const keyCol = lines[usesLine].indexOf('uses:');
  const stepIndent = ' '.repeat(keyCol);
  const childIndent = ' '.repeat(keyCol + 2);

  const withPair = stepNode.items.find((p) => String(p.key) === 'with');
  const hasSparse = withPair && stepNode.getIn(['with', 'sparse-checkout']) !== undefined;
  const generated = hasSparse && text.includes(MARK);
  if (hasSparse && !generated) return { text, status: 'manual' };

  const block = [
    `${childIndent}${MARK}`,
    `${childIndent}sparse-checkout: |`,
    ...patterns.map((p) => `${childIndent}  ${p}`),
    `${childIndent}sparse-checkout-cone-mode: false`,
  ];

  if (!withPair) {
    lines.splice(usesLine + 1, 0, `${stepIndent}with:`, ...block);
    return { text: lines.join('\n'), status: 'patched' };
  }

  // Confini del blocco `with:` esistente.
  const withLine = text.slice(0, withPair.key.range[0]).split('\n').length - 1;
  const withCol = lines[withLine].search(/\S/);
  let end = withLine + 1;
  let lastContent = withLine;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim() === '') { end++; continue; }
    if (l.search(/\S/) <= withCol) break;
    lastContent = end; end++;
  }

  // Togli un blocco generato in precedenza (marcatore + scalare + cone-mode).
  const region = lines.slice(withLine + 1, lastContent + 1);
  const kept = [];
  for (let i = 0; i < region.length; i++) {
    const l = region[i];
    if (l.includes(MARK)) continue;
    if (/^\s*sparse-checkout:\s*\|/.test(l)) {
      const ind = l.search(/\S/);
      i++;
      while (i < region.length && (region[i].trim() === '' || region[i].search(/\S/) > ind)) i++;
      i--; continue;
    }
    if (/^\s*sparse-checkout-cone-mode:/.test(l)) continue;
    kept.push(l);
  }
  lines.splice(withLine + 1, lastContent - withLine, ...kept, ...block);
  return { text: lines.join('\n'), status: 'patched' };
}

/** Confronta due YAML ignorando le chiavi che questo script ha il diritto di aggiungere. */
function semanticDiffOk(beforeRaw, afterRaw) {
  const strip = (o) => {
    if (Array.isArray(o)) return o.map(strip);
    if (o && typeof o === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(o)) {
        if (k === 'sparse-checkout' || k === 'sparse-checkout-cone-mode') continue;
        out[k] = strip(v);
      }
      // Un passo che prima non aveva `with:` ora ce l'ha, e dopo lo strip e'
      // vuoto: e' esattamente cio' che questo script ha il diritto di aggiungere.
      if (out.with && typeof out.with === 'object' && !Array.isArray(out.with) && Object.keys(out.with).length === 0) delete out.with;
      return out;
    }
    return o;
  };
  const a = JSON.stringify(strip(YAML.parse(beforeRaw, { logLevel: 'silent' })));
  const b = JSON.stringify(strip(YAML.parse(afterRaw, { logLevel: 'silent' })));
  return a === b;
}

/** Il lavoro vero. Sta dietro un guard: importare questo modulo non deve scrivere nulla. */
/**
 * Calcola e applica i profili a UN workflow gia' su disco.
 *
 * Esportata perche' i 23 `crawler-group-*.yml` sono generati da
 * `scripts/generate-crawler-group-workflows.mjs`: senza questa chiamata, il
 * primo rigenerato cancellerebbe i loro blocchi sparse in silenzio. I due
 * gruppi non hanno lo stesso profilo (20 uguali + 3 diversi, perche' i crawler
 * leggono file diversi), quindi il generatore non puo' avere una lista fissa:
 * deve passare da qui.
 *
 * Ritorna `{ text, jobsPatched, savedMb, manual }`. Non scrive: decide il
 * chiamante.
 */
export function computeProfiledText(workflowPath, npmScripts) {
  const before = fs.readFileSync(workflowPath, 'utf8');
  const analysis = analyzeWorkflow(workflowPath, npmScripts);
  const manual = [];
  let text = before, jobsPatched = 0, savedMb = 0;
  for (const job of analysis.jobs) {
    if (!job.hasCheckout || job.exclude.length === 0) continue;
    const r = patchJobCheckout(text, job.jobId, sparsePatterns(job.exclude));
    if (r.status === 'manual') { manual.push(job.jobId); continue; }
    if (r.status !== 'patched') continue;
    text = r.text; jobsPatched++; savedMb += job.savedMb;
  }
  if (text !== before) {
    YAML.parse(text, { logLevel: 'silent' });          // deve restare YAML valido
    if (!semanticDiffOk(before, text)) throw new Error("il diff semantico non e' limitato alle chiavi sparse-checkout");
  }
  return { text, before, jobsPatched, savedMb, manual };
}

/** Applica e SCRIVE. Ritorna il testo finale. */
export function applyProfilesToFile(workflowPath, npmScripts) {
  const r = computeProfiledText(workflowPath, npmScripts);
  if (r.text !== r.before) fs.writeFileSync(workflowPath, r.text);
  return r.text;
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort().filter((f) => !ONLY || f === ONLY);

  let changed = 0, skipped = 0, savedMbTot = 0, jobsPatched = 0;
  const manual = [];
  const failures = [];
  for (const f of files) {
    const full = path.join(WF_DIR, f);
    let r;
    try { r = computeProfiledText(full, pkg.scripts); }
    catch (e) { failures.push(`${f}: ${e.message}`); continue; }
    for (const j of r.manual) manual.push(`${f}:${j}`);
    jobsPatched += r.jobsPatched; savedMbTot += r.savedMb;
    if (r.text === r.before) { skipped++; continue; }
    if (!DRY) fs.writeFileSync(full, r.text);
    changed++;
  }

  console.log(`${DRY ? '[dry-run] ' : ''}workflow modificati: ${changed} | invariati: ${skipped} | job con sparse: ${jobsPatched}`);
  console.log(`peso escluso in media per job: ${(savedMbTot / Math.max(1, jobsPatched)).toFixed(0)} MB su ${TREE_MB} MB`);
  if (manual.length) console.log(`sparse scritto a mano, lasciato com'e': ${manual.length} → ${manual.join(', ')}`);
  if (failures.length) { console.error(`\n⚠️  ${failures.length} file NON modificati per verifica fallita:`); for (const x of failures) console.error('   ' + x); process.exitCode = 1; }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
