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
 * NOTA per chi lo lancia in locale: in un worktree sparse `data/` e `public/`
 * non esistono, e mancano ~160 moduli importati → il gate va rosso per motivi
 * d'ambiente, non di codice. Vedi CLAUDE.md, «Stato macchina». In CI il
 * checkout è pieno e il confronto è valido.
 *
 * Questo vale anche se il pattern sparse aggiunge a mano la sola
 * `data/typecheck-baseline.json` (issue #6061 item 2): il file esiste, ma
 * `data/blog-articles-data.ts` & co. restano non risolti, quindi `tsc`
 * produce ~126 falsi `TS2307` che finiscono nella baseline appena riscritta.
 * `isWorktreeIncomplete()` sotto intercetta anche questo caso, prima di
 * lanciare `tsc` in QUALUNQUE modalità (gate, --list, --json, --write-baseline).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(`✗ baseline assente: ${path.relative(ROOT, BASELINE_PATH)}`);
    console.error('  In un worktree sparse `data/` non è materializzata — è un problema di ambiente, non di codice.');
    console.error('  Per crearla ex-novo: node scripts/ci/check-typecheck-baseline.mjs --write-baseline');
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
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

if (isWorktreeIncomplete()) {
  console.error('✗ worktree incompleto: data/blog-articles-data.ts non risolve (worktree sparse, `data/` e `packages/articles/content/` non materializzati).');
  console.error('  È un problema di ambiente, non di codice: `tsc` produrrebbe decine di falsi TS2307 su moduli mancanti.');
  console.error('  Riproduci con un checkout PIENO (non un worktree sparse): npm run typecheck / typecheck:gate');
  process.exit(2);
}

const output = runTsc();
const { errors, skipped } = parseTsc(output);
const current = tally(errors);

if (skipped) {
  console.error(`✗ ${skipped} righe con «error TS» non riconosciute dal parser: la misura non è affidabile.`);
  process.exit(2);
}

if (args.includes('--json')) {
  console.log(JSON.stringify({ ...current, errors }, null, 2));
  process.exit(0);
}

if (args.includes('--list')) {
  for (const e of errors) console.log(`${e.file}(${e.line}): ${e.code}: ${e.msg}`);
  console.log(`\n${current.total} errori — bloccanti ${current.total - current.advisoryTotal}, tests/ ${current.advisoryTotal}`);
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

if (improvements.length) {
  const saved = improvements.reduce((s, i) => s + (i.allowed - i.count), 0);
  console.log(
    `::warning title=Baseline typecheck stantia::${saved} errori bloccanti in meno rispetto alla baseline ` +
      `(${improvements.length} file). Rigenera per stringere il ratchet: npm run typecheck:baseline`,
  );
  for (const i of improvements) console.log(`  ↓ ${i.file}: ${i.allowed} → ${i.count}`);
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
    '\nRiproduci in locale con un checkout PIENO (non un worktree sparse):  npm run typecheck\n' +
      'Non allargare la baseline per far passare la CI: la baseline registra il debito già misurato\n' +
      'il 2026-08-10, non è un posto dove metterne di nuovo.',
  );
  process.exit(1);
}

console.log('\n✓ nessuna regressione di tipo fuori da tests/.');
process.exit(0);
