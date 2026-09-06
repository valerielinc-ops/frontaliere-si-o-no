#!/usr/bin/env node
/**
 * check-typecheck-baseline.mjs — gate `tsc --noEmit` con baseline + ratchet
 * (zero-Claude, deterministico). Issue #5540.
 *
 * PERCHÉ ESISTE
 * -------------
 * Fino a questa PR nessuno script di `package.json` (285) invocava `tsc`, e
 * `tests.yml` non lo nominava: i tre check che gattano una PR (`contract`,
 * `detect`, `vitest (unit + integration)`) non guardano i tipi. Nemmeno il
 * build li guarda — Vite compila con esbuild, che le annotazioni di tipo le
 * RIMUOVE senza verificarle, quindi un errore di tipo attraversa build, deploy
 * e produzione senza produrre un solo segnale. È la classe di difetto di #5533
 * (un `undefined` dove ci si aspetta un modulo) e della storia del registro ES
 * citata in CLAUDE.md (ogni pagina articolo bloccata sullo skeleton, console
 * pulita).
 *
 * PERCHÉ UNA BASELINE E NON UN GATE A ZERO
 * ----------------------------------------
 * MISURATO su origin/main 3030ae4 con tsc 5.8.3 (`npx tsc --noEmit`, 33s):
 *
 *     331 errori, 116 file
 *     307 (93%)  in  tests/          → 96 file
 *      24 ( 7%)  fuori da tests/     → 20 file
 *
 * I 307 di `tests/` non sono quasi mai un difetto del prodotto: sono mock
 * parziali confrontati con la forma INFERITA da uno script `.mjs` non tipizzato
 * (`allowJs: true`). Prova: con `allowJs: false` gli errori scendono da 331 a
 * 160 — 171 errori, il 52% del totale, esistono solo perché TS inferisce i tipi
 * dei parametri leggendo il corpo dei JS. Portarli a zero significherebbe
 * tipizzare ~980 script, non riparare un bug.
 *
 * Dei 24 fuori da `tests/`, 20 sono conseguenze STRUTTURALI del confine fra i
 * due repo, e "ripararli" romperebbe il mirror:
 *   - `services/articleSections.ts`, `services/router{Blog,Swiss}Data.ts`,
 *     `build-plugins/shared/articleReaders.ts` importano `./engine/siteShell`
 *     & co. con path relativi che risolvono su `nanakokyobashi-rgb/…`, dove
 *     `engine/` è un fratello. Sul sito quel path non esiste per costruzione.
 *   - `data/{blog,swiss}-articles-data.ts` sono symlink a
 *     `packages/articles/content/`: TS risolve `./blogImageCdnMirror` relativo
 *     al path del LINK, non del target. Rollup/esbuild fanno il realpath, per
 *     cui a runtime funziona.
 *   - `services/seo/seo-blog*.ts` (8) importano `./seoMetadataType`, che non
 *     esiste: sono `import type`, quindi esbuild li strippa e non si vede.
 * Restano 4 errori di tipo veri, in 4 componenti diversi (vedi baseline).
 *
 * Quindi: il numero NON può andare a zero senza toccare il confine fra i repo.
 * Renderlo visibile e non-peggiorabile è il valore ottenibile oggi.
 *
 * DUE LIVELLI, PERCHÉ NON HANNO LO STESSO RAPPORTO SEGNALE/RUMORE
 * ---------------------------------------------------------------
 *   BLOCCANTE (tutto ciò che NON sta sotto `tests/`): baseline PER FILE.
 *     Un file nuovo con errori, o un file esistente che ne guadagna, → exit 1.
 *     È la superficie che finisce in produzione, e cambia di rado.
 *
 *   INFORMATIVO (`tests/`): solo il TOTALE, confrontato con la baseline.
 *     Se cresce esce un `::warning::`, mai exit 1. Su questo repo atterrano
 *     decine di test al giorno da più agenti in parallelo: un gate per-file su
 *     `tests/` andrebbe rosso di continuo per mock parziali innocui e
 *     avvelenerebbe il ciclo di auto-merge, che è esattamente il modo in cui un
 *     gate diventa rumore da aggirare.
 *
 * USO
 *   node scripts/ci/check-typecheck-baseline.mjs                  # gate
 *   node scripts/ci/check-typecheck-baseline.mjs --list           # tutti gli errori correnti
 *   node scripts/ci/check-typecheck-baseline.mjs --write-baseline # rigenera (richiede review)
 *
 * Exit: 0 = nessuna regressione bloccante; 1 = regressione; 2 = errore d'uso
 *       o `tsc` non eseguibile (MAI fail-open: se non si misura, si fallisce).
 *
 * WORKTREE SPARSE: SI MISURA LO STESSO, DICHIARANDO COSA NON SI È MISURATO
 * -------------------------------------------------------------------------
 * In un worktree sparse `data/` e `public/` non sono materializzati e ~160
 * moduli importati non risolvono. Fino a #7677 il gate trattava quel worktree
 * come «ambiente rotto» e usciva 2 PRIMA di lanciare `tsc`, sulla base di un
 * solo probe. Siccome questo repo si lavora quasi sempre in sparse (CLAUDE.md:
 * un checkout pieno costa ~3,9 GB), il risultato era ZERO typecheck in locale,
 * con il gate vivo solo in CI — cioè mai prima di aprire una PR, su codice che
 * decide rotte indicizzate.
 *
 * Ora il gate GIRA anche lì, in modalità DEGRADATA e dichiarata
 * (`scripts/ci/lib/typecheck-sparse.mjs`):
 *   - i `TS2307` il cui specificatore relativo risolve a un path che git
 *     TRACCIA ma che il worktree non ha vengono classificati come ambiente:
 *     esclusi dalla misura, contati e stampati a parte;
 *   - i file della baseline non materializzati sono dichiarati «non misurati».
 *     Zero errori su un file che `tsc` non ha nemmeno letto non è un
 *     miglioramento, quindi in sparse il ratchet sui cali tace del tutto;
 *   - il verdetto resta quello di CI: regressione per-file → exit 1, altrimenti 0.
 * La classificazione è STRETTA di proposito: un errore a valle di un modulo
 * assente (un `TS2339` su un tipo diventato `any`) NON viene scusato e resta
 * rosso. Mai fail-open: un rosso d'ambiente residuo è preferibile a un verde
 * che non ha misurato niente.
 *
 * `--write-baseline` resta VIETATO in sparse (exit 2), issue #6061 item 2:
 * riscriverla lì cementerebbe ~126 falsi `TS2307` nel ratchet. Il divieto vale
 * finché il worktree è davvero parziale — non è una condizione che scade da
 * sola, e il messaggio d'errore stampa i due comandi con cui si verifica qui e
 * ora se vale ancora.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySparseErrors, trackedButAbsent, tsconfigPaths, unmeasurableBaselineFiles } from './lib/typecheck-sparse.mjs';
// Lettore sparse-immune già esistente e documentato come tale: legge il file
// dal working tree quando c'è, altrimenti dall'oggetto git. La baseline vive
// sotto `data/`, che è proprio ciò che un worktree sparse non materializza.
import { readSiteText } from './corpus-ahead-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE_PATH = path.join(ROOT, 'data', 'typecheck-baseline.json');
const TSC_BIN = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/** Prefissi il cui conteggio è informativo, non bloccante. */
const ADVISORY_PREFIXES = ['tests/'];

const isAdvisory = (file) => ADVISORY_PREFIXES.some((p) => file.startsWith(p));

/** `path(riga,col): error TSxxxx: msg` — l'unico formato di `--pretty false`. */
const ERROR_RE = /^(?<file>[^(]+)\((?<line>\d+),(?<col>\d+)\): error (?<code>TS\d+): (?<msg>.*)$/;
/** Errore senza file (es. TS18003 «No inputs were found»): sempre bloccante. */
const GLOBAL_ERROR_RE = /^error (?<code>TS\d+): (?<msg>.*)$/;

/**
 * Distingue un worktree sparse (o parzialmente materializzato) da uno pieno
 * senza fidarsi della sola presenza della baseline JSON — un pattern sparse
 * può aggiungerla a mano senza portare con sé i moduli TS che `data/`
 * importa (es. `data/blog-articles-data.ts`, symlink a
 * `packages/articles/content/`). `fs.existsSync` su un symlink segue il
 * target: se il target manca (worktree sparse), torna `false`.
 *
 * Dal #7677 il verdetto di questo probe NON è più «fermati»: accende la
 * modalità degradata qui sotto (ed è l'unica cosa che paga la scansione di
 * `git ls-files`, che su un checkout pieno non viene mai eseguita).
 */
function isWorktreeIncomplete() {
  return !fs.existsSync(path.join(ROOT, 'data', 'blog-articles-data.ts'));
}

function runTsc() {
  if (!fs.existsSync(TSC_BIN)) {
    console.error(`✗ typescript non installato (${path.relative(ROOT, TSC_BIN)} assente). Esegui \`npm ci\`.`);
    process.exit(2);
  }
  const res = spawnSync(process.execPath, [TSC_BIN, '--noEmit', '--pretty', 'false'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) {
    console.error(`✗ impossibile eseguire tsc: ${res.error.message}`);
    process.exit(2);
  }
  // tsc: 0 = pulito, 1/2 = errori di tipo. Qualunque altro codice (o un kill per
  // OOM, signal != null) NON è una misura: fallire, mai passare in silenzio.
  if (res.signal || (res.status !== 0 && res.status !== 1 && res.status !== 2)) {
    console.error(`✗ tsc terminato in modo anomalo (status=${res.status} signal=${res.signal}).`);
    console.error((res.stdout || '').slice(-4000));
    console.error((res.stderr || '').slice(-4000));
    process.exit(2);
  }
  return `${res.stdout || ''}\n${res.stderr || ''}`;
}

/** @returns {{errors: {file:string,code:string,msg:string,line:number}[], parsed:number, skipped:number}} */
function parseTsc(output) {
  const errors = [];
  let skipped = 0;
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.includes('error TS')) continue;
    // Le righe di dettaglio annidate sono indentate: appartengono all'errore
    // precedente e non vanno contate due volte.
    if (/^\s/.test(line)) continue;
    const m = ERROR_RE.exec(line);
    if (m) {
      errors.push({
        file: m.groups.file.split(path.sep).join('/'),
        line: Number(m.groups.line),
        code: m.groups.code,
        msg: m.groups.msg,
      });
      continue;
    }
    const g = GLOBAL_ERROR_RE.exec(line);
    if (g) {
      errors.push({ file: '(global)', line: 0, code: g.groups.code, msg: g.groups.msg });
      continue;
    }
    skipped += 1;
  }
  return { errors, skipped };
}

function tally(errors) {
  const blocking = {};
  let advisoryTotal = 0;
  for (const e of errors) {
    if (isAdvisory(e.file)) advisoryTotal += 1;
    else blocking[e.file] = (blocking[e.file] || 0) + 1;
  }
  // Chiavi ordinate: la baseline deve avere un diff stabile.
  const sorted = {};
  for (const k of Object.keys(blocking).sort()) sorted[k] = blocking[k];
  return { blocking: sorted, advisoryTotal, total: errors.length };
}

function tscVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'typescript', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

function readBaseline() {
  // In un worktree sparse `data/typecheck-baseline.json` è TRACCIATA ma non
  // materializzata: leggerla solo dal disco significherebbe «assente», cioè un
  // exit 2 d'ambiente sul file che serve proprio a evitarlo. `readSiteText`
  // ricade sull'oggetto git, che c'è sotto qualunque profilo sparse.
  const raw = readSiteText(path.relative(ROOT, BASELINE_PATH).split(path.sep).join('/'));
  if (raw === null) {
    console.error(`✗ baseline assente: ${path.relative(ROOT, BASELINE_PATH)} (né nel worktree né in HEAD).`);
    console.error('  Per crearla ex-novo, da un checkout PIENO: node scripts/ci/check-typecheck-baseline.mjs --write-baseline');
    process.exit(2);
  }
  return JSON.parse(raw);
}

function writeBaseline(current, errors) {
  const payload = {
    _comment:
      'Baseline di `tsc --noEmit` (issue #5540). `blocking` = conteggio errori per file FUORI da tests/: ' +
      'un file nuovo con errori o un file che ne guadagna fa fallire la CI. `advisoryTotal` = errori sotto ' +
      'tests/, solo informativo (mock parziali contro forme inferite da .mjs non tipizzati). Il numero NON ' +
      'può andare a zero senza toccare il confine fra i due repo: vedi la testata di ' +
      'scripts/ci/check-typecheck-baseline.mjs. Rigenera SOLO dopo review umana, con checkout PIENO ' +
      '(un worktree sparse non ha data/ e public/): node scripts/ci/check-typecheck-baseline.mjs --write-baseline',
    generatedAt: new Date().toISOString().slice(0, 10),
    tscVersion: tscVersion(),
    total: current.total,
    advisoryTotal: current.advisoryTotal,
    advisoryPrefixes: ADVISORY_PREFIXES,
    blockingTotal: current.total - current.advisoryTotal,
    blocking: current.blocking,
    blockingCodes: (() => {
      const byCode = {};
      for (const e of errors) if (!isAdvisory(e.file)) byCode[e.code] = (byCode[e.code] || 0) + 1;
      return Object.fromEntries(Object.entries(byCode).sort((a, b) => b[1] - a[1]));
    })(),
  };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`✓ baseline scritta: ${path.relative(ROOT, BASELINE_PATH)}`);
  console.log(`  totale ${payload.total} — bloccanti ${payload.blockingTotal} in ${Object.keys(current.blocking).length} file, tests/ ${payload.advisoryTotal}`);
}

// ── main ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const unknown = args.filter((a) => !['--list', '--write-baseline', '--json'].includes(a));
if (unknown.length) {
  console.error(`uso: check-typecheck-baseline.mjs [--list|--write-baseline|--json]  (ignoto: ${unknown.join(' ')})`);
  process.exit(2);
}

const sparse = isWorktreeIncomplete();
const missingTracked = sparse ? trackedButAbsent(ROOT) : new Set();

if (sparse && args.includes('--write-baseline')) {
  console.error('✗ --write-baseline è vietato in un worktree sparse: la baseline registrerebbe ~126 falsi TS2307');
  console.error('  su moduli non materializzati, cementandoli nel ratchet (issue #6061 item 2).');
  console.error('  Il blocco NON scade da solo: verifica qui e ora se vale ancora, con');
  console.error('    git config core.sparseCheckout      # `true` = worktree sparse');
  console.error('    ls -l data/blog-articles-data.ts    # il symlink deve risolvere a un file leggibile');
  console.error('  Se il target risolve, il worktree è pieno e il comando torna lecito. Altrimenti rigenerala');
  console.error('  da un checkout pieno (o lascia che lo faccia la CI): il GATE, invece, gira anche di qua —');
  console.error('    node scripts/ci/check-typecheck-baseline.mjs');
  process.exit(2);
}

const output = runTsc();
const parsed = parseTsc(output);
const skipped = parsed.skipped;
let errors = parsed.errors;
let environmentErrors = [];
let downstreamErrors = [];

if (sparse) {
  const paths = tsconfigPaths(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8'));
  const split = classifySparseErrors(parsed.errors, missingTracked, { paths });
  errors = split.measured;
  environmentErrors = split.environment;
  downstreamErrors = split.downstream;
  console.log(
    `⚠️ worktree sparse: misura DEGRADATA — ${missingTracked.size} file tracciati non materializzati, ` +
      `${environmentErrors.length} errori TS2307 verso di loro esclusi dalla misura, ` +
      `${downstreamErrors.length} errori sulla stessa riga di un import rotto.`,
  );
  console.log('   Il verdetto vale sulle REGRESSIONI per-file; i cali qui non provano niente e non stringono il ratchet.');
  console.log('   La misura autorevole su quei file resta quella della CI, dove il checkout è pieno.');
  for (const e of downstreamErrors.filter((e) => !e.file.startsWith('tests/')).slice(0, 10)) {
    console.log(`   ~ ${e.file}(${e.line}): ${e.code}: ${e.msg}`);
  }
}

const current = tally(errors);

if (skipped) {
  console.error(`✗ ${skipped} righe con «error TS» non riconosciute dal parser: la misura non è affidabile.`);
  process.exit(2);
}

if (args.includes('--json')) {
  console.log(JSON.stringify({ ...current, errors, sparse, environmentErrors, downstreamErrors }, null, 2));
  process.exit(0);
}

if (args.includes('--list')) {
  for (const e of errors) console.log(`${e.file}(${e.line}): ${e.code}: ${e.msg}`);
  console.log(`\n${current.total} errori — bloccanti ${current.total - current.advisoryTotal}, tests/ ${current.advisoryTotal}`);
  for (const [label, bucket] of [
    ["errori d'ambiente (moduli tracciati ma non materializzati)", environmentErrors],
    ['errori sulla stessa riga di un import non risolto dal profilo sparse', downstreamErrors],
  ]) {
    if (!bucket.length) continue;
    console.log(`\n${bucket.length} ${label}, esclusi dal conteggio:`);
    for (const e of bucket) console.log(`  ~ ${e.file}(${e.line}): ${e.code}: ${e.msg}`);
  }
  process.exit(0);
}

if (args.includes('--write-baseline')) {
  writeBaseline(current, errors);
  process.exit(0);
}

const baseline = readBaseline();
const baseBlocking = baseline.blocking || {};
const regressions = [];
const improvements = [];

for (const [file, count] of Object.entries(current.blocking)) {
  const allowed = baseBlocking[file] || 0;
  if (count > allowed) regressions.push({ file, count, allowed });
}
for (const [file, allowed] of Object.entries(baseBlocking)) {
  const count = current.blocking[file] || 0;
  if (count < allowed) improvements.push({ file, count, allowed });
}

const blockingTotal = current.total - current.advisoryTotal;
console.log(`tsc ${tscVersion()} — ${current.total} errori (bloccanti ${blockingTotal}, tests/ ${current.advisoryTotal})`);
console.log(`baseline    — ${baseline.total} errori (bloccanti ${baseline.blockingTotal}, tests/ ${baseline.advisoryTotal})`);

if (current.advisoryTotal > (baseline.advisoryTotal ?? 0)) {
  const delta = current.advisoryTotal - baseline.advisoryTotal;
  console.log(
    `::warning title=Typecheck (tests/)::+${delta} errori di tipo sotto tests/ ` +
      `(${baseline.advisoryTotal} → ${current.advisoryTotal}). Informativo, non blocca. ` +
      'Se sono tuoi: `npx tsc --noEmit` e sistema, oppure rigenera la baseline.',
  );
}

if (improvements.length && !sparse) {
  const saved = improvements.reduce((s, i) => s + (i.allowed - i.count), 0);
  console.log(
    `::warning title=Baseline typecheck stantia::${saved} errori bloccanti in meno rispetto alla baseline ` +
      `(${improvements.length} file). Rigenera per stringere il ratchet: npm run typecheck:baseline`,
  );
  for (const i of improvements) console.log(`  ↓ ${i.file}: ${i.allowed} → ${i.count}`);
} else if (improvements.length) {
  // In sparse un calo non è un progresso provato: può essere un file che `tsc`
  // non ha letto, o un errore riclassificato come ambiente. Dirlo, non contarlo.
  const unmeasurable = unmeasurableBaselineFiles(baseBlocking, missingTracked);
  console.log(
    `ⓘ ${improvements.length} file della baseline mostrano meno errori qui: NON è un miglioramento misurato ` +
      `(worktree sparse), e il ratchet non si stringe da un checkout parziale.`,
  );
  if (unmeasurable.length) {
    console.log(`  ${unmeasurable.length} di questi non sono proprio materializzati: ${unmeasurable.slice(0, 5).join(', ')}${unmeasurable.length > 5 ? ' …' : ''}`);
  }
}

if (regressions.length) {
  const added = regressions.reduce((s, r) => s + (r.count - r.allowed), 0);
  console.error(`\n✗ ${added} nuovo/i errore/i di tipo fuori da tests/, in ${regressions.length} file:\n`);
  for (const r of regressions) {
    console.error(`  ${r.file}: ${r.allowed} → ${r.count}`);
    for (const e of errors.filter((e) => e.file === r.file)) {
      console.error(`      ${r.file}(${e.line}): ${e.code}: ${e.msg}`);
    }
  }
  console.error(
    (sparse
      ? '\nWorktree sparse: gli errori qui sopra NON sono stati scusati come ambiente (solo i TS2307 verso\n' +
        'moduli tracciati e non materializzati lo sono). Se sospetti il contrario, riconferma da un checkout\n' +
        'PIENO prima di toccare il codice:  npm run typecheck\n'
      : '\nRiproduci in locale con un checkout PIENO (non un worktree sparse):  npm run typecheck\n') +
      'Non allargare la baseline per far passare la CI: la baseline registra il debito già misurato\n' +
      'il 2026-08-10, non è un posto dove metterne di nuovo.',
  );
  process.exit(1);
}

console.log('\n✓ nessuna regressione di tipo fuori da tests/.');
process.exit(0);
