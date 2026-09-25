#!/usr/bin/env node
/**
 * Verifica che lo sparse-checkout scritto nei workflow sia ancora coerente col
 * codice che quei workflow eseguono.
 *
 * E' il guard che rende sostenibile l'operazione. Il rischio di uno sparse
 * checkout non e' il giorno in cui lo scrivi — e' il mese dopo, quando qualcuno
 * fa leggere `data/jobs/` a uno script che prima non lo leggeva e il job muore
 * in produzione con ENOENT. Qui quel cambiamento diventa una CI rossa.
 *
 * Per i profili a esclusione (`/*` + `!/bucket/`) controlla tre cose, per le
 * allow-list scritte a mano una (vedi sotto, dal 2026-09-25):
 *   0. allow-list: ogni file di codice che il job carica — chiusura statica,
 *      bersagli dei symlink compresi — e' materializzato (git decide la
 *      corrispondenza, `pathsOutsideSparseRules`);
 *   1. nessun file di CODICE che il job carica finisce fra gli esclusi — per un
 *      job che esegue `tsc` questo include l'intero programma TypeScript
 *      (`tsProgramFiles()`, issue #6149), non solo gli entry point raggiunti
 *      per `import`: `tsc` gira come sottoprocesso e la chiusura transitiva
 *      degli import non lo vede;
 *   2. i pattern sono ben formati (`/*` per primo, poi solo negazioni);
 *   3. le esclusioni scritte non sono piu' larghe di quelle che l'analizzatore
 *      calcola oggi — cioe' il workflow non sta escludendo qualcosa che il suo
 *      codice ha cominciato a usare.
 *
 * Il verso del confronto conta: escludere MENO del calcolato e' legittimo (una
 * scelta prudente a mano), escludere DI PIU' no.
 *
 *   node scripts/ci/verify-checkout-profiles.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { analyzeWorkflow, transitiveClosure, ROOT, BUCKETS, CROSSOVER_MB, TREE_MB } from './checkout-profile-analyzer.mjs';

const WF_DIR = path.join(ROOT, '.github/workflows');

/**
 * Percorsi tracciati, letti UNA volta dall'albero di HEAD.
 *
 * Serve a distinguere un percorso vero da una URL o da un esempio in un
 * commento: `${CDN}/data/blog-index.json` somiglia a un file locale e non lo e'.
 * Si legge da HEAD e non da `origin/main` perche' in CI il remote-tracking ref
 * puo' non esserci (checkout a profondita' 1).
 */
let TRACKED = null;
function trackedPaths() {
  if (TRACKED) return TRACKED;
  try {
    const out = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: ROOT, maxBuffer: 1 << 28 }).toString();
    TRACKED = new Set(out.split('\n').filter(Boolean));
  } catch { TRACKED = new Set(); }
  return TRACKED;
}

/**
 * Controllo INDIPENDENTE dall'analizzatore: estrae i percorsi letterali dal
 * codice che il job carica e verifica che nessuno di quelli realmente tracciati
 * finisca fra gli esclusi.
 *
 * Vale la duplicazione proprio perche' il metodo e' diverso. Ha trovato due
 * casi che l'analisi aveva mancato — `guard-data-integrity.mjs` e
 * `validate-third-party-secrets.mjs`, entrambi con i percorsi dentro un array
 * letterale — dovuti a un difetto nella normalizzazione delle forme spezzate.
 * Un secondo controllo che riusasse la stessa logica non li avrebbe visti.
 */
const LITERAL_PATH = /['"`]((?:\.\.\/|\.\/)*(?:data|public|docs|packages)\/[A-Za-z0-9._/-]+)['"`]/g;

export function literalPathsIn(source) {
  const out = new Set();
  for (const m of source.matchAll(LITERAL_PATH)) out.add(m[1].replace(/^(\.\.\/|\.\/)+/, ''));
  return out;
}

/**
 * Un job che esegue `tsc` non "carica" il suo codice per import: lo passa al
 * compilatore come sottoprocesso, invisibile alla chiusura transitiva basata
 * su `import`/`require` che alimenta `job.closure`. Il vero consumatore e' il
 * PROGRAMMA dichiarato da `tsconfig.json` — qui senza `include`, quindi tutti
 * i `.ts`/`.tsx` tracciati fuori da `node_modules`. Vedi issue #6149.
 *
 * Il segnale NON e' la sotto-stringa «tsc» da sola: compare anche in un nome
 * job/commento innocuo (`typecheck (tsc --noEmit)` in `checkRunObservation.mjs`,
 * falso positivo osservato), e non basta nemmeno «importa il pacchetto
 * typescript»: `duplicateDeclarations.mjs` lo importa ma chiama solo
 * `ts.createSourceFile` per file, mai `ts.createProgram` — parsing di un AST,
 * non type-check del programma dichiarato da `tsconfig.json` (altro falso
 * positivo osservato). Serve un pattern che sia davvero un'invocazione a
 * programma intero: il binario CLI risolto via
 * `path.join(..., 'typescript', 'bin', 'tsc')` (come fa
 * `check-typecheck-baseline.mjs`), `npx tsc`, o il Compiler API a livello di
 * programma (`ts.createProgram`).
 */
const TSC_INVOCATION_PATTERNS = [
  /(['"`])typescript\1\s*,\s*(['"`])bin\2\s*,\s*(['"`])tsc\3/,
  /\bnpx\s+(?:-y\s+)?tsc\b/,
  /\bts\.createProgram\s*\(/,
];

/** Un job invoca il binario tsc, in un file qualunque della sua chiusura nota? */
function jobInvokesTsc(job) {
  for (const rel of job.closure ?? []) {
    let src;
    try { src = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
    if (TSC_INVOCATION_PATTERNS.some((re) => re.test(src))) return true;
  }
  return false;
}

let TS_PROGRAM_FILES = null;
/** Tutti i `.ts`/`.tsx` tracciati: la chiusura reale di un `tsc` senza `include`. */
function tsProgramFiles() {
  if (TS_PROGRAM_FILES) return TS_PROGRAM_FILES;
  TS_PROGRAM_FILES = [...trackedPaths()].filter((p) => /\.tsx?$/.test(p) && !p.startsWith('node_modules/'));
  return TS_PROGRAM_FILES;
}

/**
 * Percorso importato via una vera dichiarazione `import`/`export ... from`
 * o `import('...')` verso `data/` o `public/`. Deliberatamente PIU' STRETTO
 * di `literalPathsIn`, in due modi, entrambi misurati come falsi positivi
 * reali su questo repo:
 *   - un file di programma TS puo' contenere una stringa `'data/x.json'`
 *     passata a `fs.readFileSync` a runtime — la legge il CODICE quando gira,
 *     non `tsc` quando compila (29 falsi positivi su una prima versione che
 *     riusava `literalPathsIn` sui file di test/build-plugin);
 *   - la parola «from» isolata compare anche in prosa inglese dentro un
 *     commento/docblock («Local placeholder served from `public/...`.» in
 *     `jobsSeoPagesPlugin.ts`) — richiede quindi la keyword `import`/`export`
 *     prima, non «from» da sola.
 * `[\s\S]{0,300}?` copre gli import multi-riga (named import lunghi) restando
 * limitato per non attraversare due statement distinti.
 */
const IMPORT_STATEMENT = /\b(?:import|export)\b[\s\S]{0,300}?\bfrom\s+['"`]([^'"`]+)['"`]|\b(?:import|require)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

export function importedDataOrPublicPathsIn(source) {
  const out = new Set();
  for (const m of source.matchAll(IMPORT_STATEMENT)) {
    const raw = m[1] ?? m[2];
    const idx = raw?.search(/(?:data|public)\//) ?? -1;
    if (idx >= 0) out.add(raw.slice(idx));
  }
  return out;
}

/**
 * I percorsi di `paths` che una lista di regole sparse NON materializza.
 *
 * Decide git stesso (`git sparse-checkout check-rules`, git >= 2.41), non una
 * reimplementazione: le allow-list scritte a mano usano la sintassi gitignore
 * non-cone (`scripts/` vale a ogni profondita', `scripts/lib/**`, negazioni) o
 * la modalita' cone (directory, file di root sempre inclusi), e un matcher
 * fatto in casa sbaglierebbe proprio sui casi limite. Senza git non si puo'
 * rispondere: si lancia, e il chiamante lo trasforma in un problema — un
 * controllo che non ha guardato non deve leggersi come «tutto coperto».
 */
export function pathsOutsideSparseRules(patterns, paths, { cone = false, cwd = ROOT } = {}) {
  const list = [...new Set(paths)].filter(Boolean);
  if (!list.length) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparse-rules-'));
  try {
    const rules = path.join(dir, 'rules');
    fs.writeFileSync(rules, `${patterns.join('\n')}\n`);
    const out = execFileSync(
      'git',
      ['sparse-checkout', 'check-rules', cone ? '--cone' : '--no-cone', '--rules-file', rules],
      { cwd, input: `${list.join('\n')}\n`, maxBuffer: 1 << 26, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString();
    const inside = new Set(out.split('\n').filter(Boolean));
    return list.filter((p) => !inside.has(p));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * I file di codice che un job carica e che la sua allow-list sparse non
 * materializza: chiusura STATICA degli entry point (piu' i moduli importati da
 * heredoc/`node -e`), bersagli dei symlink compresi. Vuoto = coperta.
 */
export function uncoveredAllowListCode(lines, entries, { cone = false } = {}) {
  const loaded = transitiveClosure([...new Set(entries)], { staticOnly: true }).map((r) => r.rel);
  return pathsOutsideSparseRules(lines, loaded, { cone });
}

/** Un percorso e' fuori dal checkout, dati i pattern sparse non-cone. */
export function isExcludedBy(patterns, p) {
  const list = Array.isArray(patterns) ? patterns : [];
  const structured = list.some((pattern) => /^!?\//.test(String(pattern).trim()));
  if (!structured) {
    return list.some((e) => (e.endsWith('/') ? p.startsWith(e) : p === e));
  }

  // Git applica i pattern in ordine: una reinclusione successiva a una
  // negazione riporta il percorso nel checkout (es. data/loop-fleet/).
  let included = true;
  for (const raw of list) {
    const pattern = String(raw).trim();
    if (!pattern) continue;
    const negated = pattern.startsWith('!');
    const target = pattern.replace(/^!?\//, '');
    if (target === '*' || target === '') {
      included = !negated;
      continue;
    }
    const matches = target.endsWith('/')
      ? p.startsWith(target)
      : p === target;
    if (matches) included = !negated;
  }
  return !included;
}

export function verifyCheckoutProfiles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const problems = [];
  let jobs = 0, withSparse = 0, allowListsVerified = 0;


  for (const f of fs.readdirSync(WF_DIR).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    const full = path.join(WF_DIR, f);
    const raw = fs.readFileSync(full, 'utf8');
    let doc;
    try { doc = YAML.parse(raw, { logLevel: 'silent' }); } catch (e) { problems.push(`${f}: YAML illeggibile — ${e.message}`); continue; }
    const analysis = analyzeWorkflow(full, pkg.scripts);

    for (const job of analysis.jobs) {
      jobs++;
      const step = (doc?.jobs?.[job.jobId]?.steps ?? [])
        .find((s) => typeof s?.uses === 'string' && s.uses.startsWith('actions/checkout@'));
      const sparse = step?.with?.['sparse-checkout'];
      if (sparse === undefined) continue;
      withSparse++;
      const where = `${f}:${job.jobId}`;

      const lines = String(sparse).split('\n').map((l) => l.trim()).filter(Boolean);
      // Gli sparse scritti a mano possono usare una allow-list: si riconoscono
      // perche' non cominciano con `/*`. Fino al 2026-09-25 qui si saltavano del
      // tutto («non li si giudica qui»), e #9835 e' arrivata su main con un
      // watchdog che importava `build-plugins/shared/articleSectionCore.mjs` —
      // un symlink verso `packages/articles/engine/…`, fuori dalla sua
      // allow-list: ERR_MODULE_NOT_FOUND alla prima run (36128534394), CI
      // verde. Per una allow-list l'invariante e' lo stesso del punto 1 sotto:
      // ogni file di codice che il job carica, bersagli dei symlink compresi
      // (vedi transitiveClosure), deve essere materializzato. Si misura sulla
      // chiusura STATICA (piu' i moduli importati da heredoc/`node -e`): e' cio'
      // che Node collega prima di eseguire, e che quindi fallisce SEMPRE; un
      // `import()` pigro su un ramo che il job non percorre non lo rompe.
      if (lines[0] !== '/*') {
        // Attribuibile solo se questo e' L'UNICO checkout del job, alla radice:
        // con piu' checkout (matrix-equivalence-check.yml: uno sparse solo per
        // l'action composita, poi `tooling/` e `build/` pieni) il codice gira
        // da un altro albero e la chiusura non appartiene a questa allow-list.
        const checkouts = (doc?.jobs?.[job.jobId]?.steps ?? [])
          .filter((s) => typeof s?.uses === 'string' && s.uses.startsWith('actions/checkout@'));
        if (checkouts.length !== 1 || step.with.path) continue;
        const cone = step.with['sparse-checkout-cone-mode'] !== false;
        allowListsVerified++;
        let missing = [];
        try {
          missing = uncoveredAllowListCode(lines, [...(job.entries ?? []), ...(job.inlineEntries ?? [])], { cone });
        } catch (e) {
          problems.push(`${where}: allow-list sparse non verificabile (git sparse-checkout check-rules: ${String(e.message || e).split('\n')[0]})`);
          continue;
        }
        for (const rel of missing) {
          problems.push(`${where}: l'allow-list sparse non materializza ${rel}, che il job carica come codice`);
        }
        continue;
      }

      // Sopra la soglia di convenienza lo sparse rallenta invece di aiutare:
      // un profilo li' sopra e' un difetto, non un'ottimizzazione.
      if (job.aboveCrossover) {
        problems.push(`${where}: ha uno sparse-checkout ma resterebbe a ${TREE_MB} MB, ` +
          `sopra la soglia di ${CROSSOVER_MB} MB oltre la quale lo sparse e' piu' lento. ` +
          `Rigenera con: node scripts/ci/apply-checkout-profiles.mjs`);
      }

      const patternLines = lines.slice(1);
      for (const l of patternLines) {
        if (!/^!?\/[\w./-]+$/.test(l)) problems.push(`${where}: pattern malformato «${l}»`);
      }
      if (step.with['sparse-checkout-cone-mode'] !== false) {
        problems.push(`${where}: i pattern con negazione richiedono sparse-checkout-cone-mode: false`);
      }

      const excluded = patternLines.filter((l) => l.startsWith('!/')).map((l) => l.slice(2));
      const isPathOutsideCheckout = (p) => isExcludedBy(patternLines, p);

      // Se il job passa il codice a `tsc`, la chiusura per import non basta:
      // si estende al programma TS intero (vedi jobInvokesTsc/tsProgramFiles).
      const runsTsc = jobInvokesTsc(job);
      const closureFiles = runsTsc
        ? [...new Set([...(job.closure ?? []), ...tsProgramFiles()])]
        : (job.closure ?? []);

      // 1. il codice che il job carica deve sopravvivere
      for (const rel of closureFiles) {
        if (isPathOutsideCheckout(rel)) problems.push(`${where}: escluderebbe il codice ${rel}`);
      }

      // 2. nessun percorso letterale letto da quel codice deve finire fuori
      const tracked = trackedPaths();
      for (const rel of (job.closure ?? [])) {
        let src;
        try { src = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
        for (const lit of literalPathsIn(src)) {
          if (!tracked.has(lit)) continue;              // URL o esempio, non un file
          if (isPathOutsideCheckout(lit)) {
            problems.push(`${where}: ${rel} legge «${lit}», che i pattern escludono. ` +
              `Rigenera con: node scripts/ci/apply-checkout-profiles.mjs`);
          }
        }
      }

      // 2b. stesso controllo per il programma TS intero, ma solo sugli IMPORT
      // (`tsc` risolve gli specificatori sul disco, non le stringhe generiche —
      // vedi importedDataOrPublicPathsIn).
      if (runsTsc) {
        for (const rel of tsProgramFiles()) {
          let src;
          try { src = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
          for (const lit of importedDataOrPublicPathsIn(src)) {
            if (!tracked.has(lit)) continue;
            if (isPathOutsideCheckout(lit)) {
              problems.push(`${where}: ${rel} importa «${lit}», che i pattern escludono. ` +
                `Rigenera con: node scripts/ci/apply-checkout-profiles.mjs`);
            }
          }
        }
      }

      // 3. non escludere piu' di quanto l'analisi consenta oggi
      // Un'esclusione e' legittima se:
      //   a) e' esattamente un bucket che l'analisi dichiara non necessario;
      //   b) e' CONTENUTA in uno di quei bucket (`public/images/events` dentro
      //      `public/images/`) — togliere meno di quanto concesso e' sempre ok;
      //   c) CONTIENE solo bucket concessi (`public/` sopra `public/images/` e
      //      `public/data/`): il residuo e' materiale di baseline, ed e' una
      //      scelta esplicita di chi ha scritto il profilo a mano.
      const allowed = new Set(job.exclude);
      for (const e of excluded) {
        const inside = [...allowed].some((b) => e.startsWith(b));
        const covering = BUCKETS.some((b) => b.id.startsWith(e)) &&
          BUCKETS.filter((b) => b.id.startsWith(e)).every((b) => allowed.has(b.id));
        if (allowed.has(e) || inside || covering) continue;
        problems.push(`${where}: esclude «${e}», ma il codice del job lo usa ora. ` +
          `Rigenera con: node scripts/ci/apply-checkout-profiles.mjs`);
      }
    }
  }
  return { problems, jobs, withSparse, allowListsVerified };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { problems, jobs, withSparse, allowListsVerified } = verifyCheckoutProfiles();
  console.log(`job esaminati: ${jobs} | con sparse-checkout: ${withSparse} | allow-list verificate: ${allowListsVerified}`);
  if (problems.length) {
    console.error(`\n❌ ${problems.length} problemi:`);
    for (const p of problems) console.error('   ' + p);
    process.exit(1);
  }
  console.log('✅ profili di checkout coerenti col codice');
}
