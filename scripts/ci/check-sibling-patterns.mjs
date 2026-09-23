/**
 * check-sibling-patterns.mjs — surface untouched sibling files that share the
 * code constructs your branch just changed (zero-Claude, deterministico).
 *
 * Root cause (issue #1348): la regola AGENTS.md #6 / Fix flow chiede al fixer di
 * `grep` i file gemelli per lo stesso costrutto e sweepare l'intera classe del
 * bug nella STESSA PR. La regola è prosa: spiega il "cosa" ma non il "come"
 * meccanico, quindi il fixer deve costruire la grep a mano ogni volta e spesso
 * salta un sibling → 🔴 reviewer "stesso antipattern nel file gemello" ricorrente
 * (bucket `reviewer-finding/sibling-class-fix`, ×7 in 14gg). Questo script
 * AUTOMATIZZA quella grep: prende i costrutti distintivi che il diff ha toccato
 * (costanti SCREAMING_SNAKE, helper camelCase distintivi, moduli kebab-case in
 * import/require) e cerca quali ALTRI file di codice — non toccati dal branch —
 * li contengono. Il fixer li ispeziona e decide: includere il fix o giustificare
 * in `## Non implementato`.
 *
 * NON è un gate (advisory, exit 0 di default): è un candidate-surfacer. Surfacare
 * candidati basati su token condivisi non garantisce che ognuno abbia lo stesso
 * antipattern — è il punto di partenza della grep, non il verdetto. Per usarlo
 * come gate CI: `--strict` (exit 1 se trova ≥1 candidato).
 *
 * Logica:
 *   1. Diff del branch vs base (default `origin/main`, three-dot dal merge-base).
 *   2. File di codice cambiati (CODE_DIRS, esclusi data/public/reports/dist/…).
 *   3. Dalle righe cambiate (+/-) estrae token distintivi (vedi extractTokens).
 *   4. Per ogni token `git grep -lF` sui CODE_DIRS → file che lo contengono.
 *   5. Riporta i file NON toccati dal branch, rankati per # di token condivisi.
 *   6. Pass verbatim (issue #4260): estrae espressioni significative dalle sole
 *      righe rimosse (-) e le cerca con `git grep -F` (stessa soglia MAX_FILES
 *      del token-match). Cattura i gemelli che condividono solo il vecchio
 *      anti-pattern rimosso, invisibili al token-match perché non importano
 *      ancora il helper NUOVO introdotto dal fix (il caso PR #4224 / PR #4199).
 *   7. Pattern-class registry (issue #4260 escalation, round 2): i pass 3-6
 *      sono tutti LESSICALI — servono un token o un'espressione VERBATIM
 *      condivisa. Il bucket `sibling-class-fix` ha continuato a ricorrere
 *      (×6 in 14gg dopo il pass #6: #4252/#4224/#4221/#4200/#4199) perché una
 *      classe di finding ricorrenti è STRUTTURALE/LOGIC-LEVEL, non lessicale:
 *      stessa FORMA di bug in file con nomi di variabile/helper completamente
 *      diversi (es. issue #4208 "cap calcolato prima di una mutazione dello
 *      stesso oggetto sorgente", issue #4263 item 4 "closeBundle legge
 *      l'output di un altro plugin senza `sequential: true`") — nessun token
 *      comune da estrarre, il pass lessicale è strutturalmente cieco. Questo
 *      pass aggiunge un REGISTRO curato (`PATTERN_CLASSES`) di forme di bug
 *      note e ricorrenti: ciascuna ha un nome, una descrizione e un detector
 *      euristico (grep AST-lite, non un parser) che scansiona TUTTI i file
 *      gemelli tracked in CODE_DIRS — non solo quelli che condividono un
 *      token col diff — cercando la STESSA forma. Stesso principio
 *      "candidato ≠ verdetto" dei pass precedenti: un match è un invito a
 *      ispezionare, non una diagnosi. Escalation #5426 (il bucket ricorso
 *      ancora ×6 in 14gg dopo round 2, serie PR #5423/#5419/#5405/#5390/
 *      #5378): terza classe registrata, `persist-time-country-stamp` — uno
 *      script di crawling forgia `addressCountry = 'CH'` su un record job
 *      prima di persisterlo, stessa evidenza distrutta reimplementata con
 *      identificatori diversi in ogni sibling, nessun token condiviso.
 *
 *   8. `--head <ref>` (2026-09-05): i pass 1-7 leggono di default il WORKING
 *      TREE della directory da cui il processo gira — deliberato per l'uso
 *      advisory pre-push, dove il fix può non essere ancora committato. Per un
 *      GATE quella dipendenza dalla directory è un difetto: `sibling-check-gate`
 *      gira come hook PreToolUse e riceve `payload.cwd`, cioè il working
 *      directory TRACCIATO della sessione, che in una flotta di agenti è spesso
 *      il checkout principale condiviso. Misurato il 2026-09-05 su questo
 *      repository: dal checkout principale (sporco del lavoro non committato di
 *      un'altra sessione su `scripts/lib/prospector/**`) lo script riportava 5
 *      file cambiati e 44 candidati; dal worktree pulito dello stesso momento,
 *      0 e 0. Nessuna dichiarazione di falso positivo poteva soddisfare quel
 *      gate: i candidati non appartenevano al branch in apertura. Con
 *      `--head <ref>` diff, `git grep` e la lettura del contenuto per il
 *      pattern-class registry sono tutti scopati a QUEL ref — i worktree
 *      condividono `.git`, quindi un branch dà lo stesso identico verdetto da
 *      qualunque directory del repo. Diagnostico: esegui lo script dal checkout
 *      principale e da un worktree e confronta «File di codice cambiati»; senza
 *      `--head` i due numeri divergono, con `--head <branch>` no.
 *
 *   9. Matching AST e binding locali (2026-09-21): quando un token del diff ha
 *      una forma TypeScript riconoscibile (call, member, declaration, import o
 *      literal), il candidato deve contenere la stessa forma AST. Per gli
 *      import locali viene risolto anche il modulo e il nome esportato, così
 *      due helper omonimi di moduli diversi non vengono trattati come lo stesso
 *      simbolo. API di pacchetto e identificatori locali nudi non sono evidenza
 *      strutturale: eliminano il rumore di `ts.createSourceFile`, `sourceFile`
 *      e simili. È un grafo temporaneo per la singola scansione, non un index
 *      persistente; commenti e API di pacchetto non diventano segnali, mentre
 *      slug/config literal sono fatti AST di tipo `literal` e file non
 *      analizzabili dal parser mantengono il pass lessicale storico.
 *
 *   10. Cache concorrente per `--head`: il risultato JSON di una revisione
 *       immutabile viene condiviso tra hook paralleli, con lock atomico e
 *       scrittura atomica. Le scansioni del working tree non vengono mai
 *       memorizzate perché potrebbero cambiare durante la run. Per la
 *       scansione dei contenuti, il ref viene anche estratto in un piccolo
 *       snapshot temporaneo e letto una volta per file: evita che ogni token
 *       avvii un nuovo `git grep` con il suo picco di memoria.
 *
 * Uso:
 *   node scripts/ci/check-sibling-patterns.mjs            # advisory, exit 0
 *   node scripts/ci/check-sibling-patterns.mjs --base <ref>
 *   node scripts/ci/check-sibling-patterns.mjs --head <ref>  # ref, non working tree
 *   node scripts/ci/check-sibling-patterns.mjs --strict   # exit 1 se candidati
 *   node scripts/ci/check-sibling-patterns.mjs --json
 *
 * Nessuna dipendenza Node aggiuntiva: usa il TypeScript già presente nel
 * progetto e git in PATH. `tar` è usato solo per l'ottimizzazione `--head`;
 * se manca, il checker torna al percorso Git storico. Cerca sempre solo file
 * tracked.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMergeBase, formatUnresolvableMergeBaseVerdict } from './lib/resolve-merge-base.mjs';
import {
  astMatchLabels,
  collectAstFacts,
  diffLineRanges,
  factsContainingToken,
  isActionableAstFact,
  isAstSourceFile,
  matchAstFacts,
} from './lib/sibling-ast-graph.mjs';

const argv = process.argv.slice(2);
const STRICT = argv.includes('--strict');
const JSON_OUT = argv.includes('--json');
const HELP = argv.includes('--help') || argv.includes('-h');
const baseIdx = argv.indexOf('--base');
const BASE_ARG = baseIdx >= 0 ? argv[baseIdx + 1] : null;
// `--head <ref>`: analizza QUEL ref invece del working tree della directory
// corrente (vedi HEAD_REF sotto). Default `null` = comportamento storico.
const headIdx = argv.indexOf('--head');
const HEAD_REF = headIdx >= 0 && argv[headIdx + 1] ? argv[headIdx + 1] : null;

if (HELP) {
  console.log(
    'check-sibling-patterns.mjs — surface untouched sibling files sharing the\n' +
      'code constructs your branch changed (sibling-class-fix helper, issue #1348).\n\n' +
      'Flags: --base <ref> (default origin/main) · --head <ref> (default: working tree)\n' +
      '       --strict (exit 1 if candidates) · --json · --help',
  );
  process.exit(0);
}

// Directory di codice funnel-critical da analizzare e cercare. I blob rigenerati
// (data/public/reports/_newsletter_variants/dist) sono ESCLUSI: non sono code da
// sweepare per antipattern (CODE vs DATA, AGENTS.md / ISSUES.md).
const CODE_DIRS = [
  'scripts',
  'build-plugins',
  'services',
  'functions',
  'server',
  'hooks',
  'components',
  '.github/workflows',
];
const EXCLUDE_PATHSPECS = [
  ':(exclude)**/data/**',
  ':(exclude)data/**',
  ':(exclude)public/**',
  ':(exclude)reports/**',
  ':(exclude)_newsletter_variants/**',
  ':(exclude)dist/**',
  ':(exclude)node_modules/**',
];

const isCodeFile = (f) =>
  CODE_DIRS.some((d) => f === d || f.startsWith(d + '/')) &&
  !/(^|\/)(data|public|reports|_newsletter_variants|dist|node_modules)\//.test(f);

// Token troppo comuni per essere segnale di "classe" condivisa: built-in JS/DOM,
// idiomi onnipresenti, env globali. Un match qui non distingue un file gemello.
const STOP = new Set([
  // JS/DOM idioms
  'toString', 'valueOf', 'forEach', 'hasOwnProperty', 'getElementById',
  'querySelector', 'querySelectorAll', 'addEventListener', 'removeEventListener',
  'parseInt', 'parseFloat', 'toISOString', 'toLocaleString', 'toLowerCase',
  'toUpperCase', 'charAt', 'indexOf', 'lastIndexOf', 'includes', 'replaceAll',
  'startsWith', 'endsWith', 'getAttribute', 'setAttribute', 'createElement',
  'appendChild', 'textContent', 'innerHTML', 'getTime', 'getFullYear',
  'stringify', 'execFileSync', 'execSync', 'spawnSync', 'readFileSync',
  'writeFileSync', 'existsSync', 'readdirSync', 'mkdirSync', 'createHash',
  'fileURLToPath', 'dirname', 'basename', 'resolve', 'process', 'console',
  'undefined', 'function', 'require', 'module', 'default', 'constructor',
  'localStorage', 'sessionStorage', 'JSON', 'Promise', 'Object', 'Array',
  'Boolean', 'Number', 'String', 'Symbol', 'Reflect', 'isArray', 'isInteger',
  'fromEntries', 'getOwnPropertyNames', 'setTimeout', 'setInterval',
  // env / common consts
  'GITHUB_TOKEN', 'GITHUB_PAT', 'GH_TOKEN', 'GITHUB_REPOSITORY', 'NODE_ENV',
  'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GITHUB_OUTPUT', 'GITHUB_ENV',
  'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_ACTOR', 'GITHUB_EVENT_NAME',
  // Builtin di bash: stessa classe di `process`/`console` per il JS. Ogni
  // script .sh che vuole risalire alla propria cartella scrive `BASH_SOURCE`,
  // quindi il token accomunava 14 file senza indicare nessun antipattern.
  'BASH_SOURCE', 'FUNCNAME', 'IFS', 'PIPESTATUS', 'BASH_REMATCH',
]);

// Un token che compare in più di MAX_FILES file tracked è troppo generico per
// indicare un file gemello specifico → lo scartiamo (sarebbe solo rumore).
const MAX_FILES = 15;

// Un pattern-class del registro (vedi PATTERN_CLASSES) che flagga più di
// MAX_PATTERN_CLASS_HITS file NON è più un "candidato mirato" — è il
// detector che spara troppo largo (misfire), non un segnale reale sul
// repo. In quel caso i risultati di quella classe vengono scartati per
// questa run invece di floodare l'output (vedi doc del registro sopra).
const MAX_PATTERN_CLASS_HITS = 15;

// Il gate può essere invocato in parallelo da più sessioni agent. Cache solo
// analisi `--head` immutabili: il working tree può cambiare tra due chiamate.
// Incrementare quando cambiano le semantiche dei candidati, per non riusare
// JSON prodotti da una versione precedente.
const CHECK_CACHE_VERSION = '2026-09-23-v3';
const CHECK_CACHE_WAIT_MS = 240_000;
const CHECK_CACHE_STALE_MS = 600_000;
const CHECK_CACHE_POLL_MS = 100;
const CHECK_CACHE_DISABLED = process.env.CHECK_SIBLING_PATTERNS_CACHE === '0';
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
let HEAD_SNAPSHOT_ROOT = null;

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: allowFail ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
}

function sleepSync(milliseconds) {
  Atomics.wait(SLEEP_CELL, 0, 0, milliseconds);
}

function resolvedRevision(ref) {
  return git(['rev-parse', '--verify', `${ref}^{commit}`], { allowFail: true }).trim();
}

function readCachedResult(cachePath) {
  try {
    const result = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (
      !result ||
      typeof result !== 'object' ||
      !Array.isArray(result.changedCode) ||
      !Array.isArray(result.candidates)
    ) {
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

function tryClaimCacheLock(lockPath) {
  try {
    const fd = openSync(lockPath, 'wx');
    closeSync(fd);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    return null;
  }
}

function cacheLockIsStale(lockPath) {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > CHECK_CACHE_STALE_MS;
  } catch {
    return false;
  }
}

function removeCacheLock(lockPath) {
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // Optional cache only: a lock cleanup failure must not affect the verdict.
  }
}

/**
 * Deduplicate immutable `--head` sweeps across concurrent hook processes.
 * A cache miss still runs the normal analysis; a process that sees another
 * owner waits for its small JSON result instead of starting another AST/git
 * sweep. Cache failures are deliberately fail-open for the checker itself.
 */
function createHeadCache(base, mergeBase) {
  if (!HEAD_REF || CHECK_CACHE_DISABLED) return null;

  const headRevision = resolvedRevision(HEAD_REF);
  const baseRevision = resolvedRevision(base);
  const commonDir = git(['rev-parse', '--git-common-dir'], { allowFail: true }).trim();
  if (!headRevision || !baseRevision || !commonDir) return null;

  const identity = [
    CHECK_CACHE_VERSION,
    resolve(commonDir),
    base,
    HEAD_REF,
    baseRevision,
    headRevision,
    mergeBase,
  ].join('\n');
  const key = createHash('sha256').update(identity).digest('hex');
  const cacheDir = join(tmpdir(), 'frontaliere-check-sibling-patterns');
  const cachePath = join(cacheDir, `${key}.json`);
  const lockPath = join(cacheDir, `${key}.lock`);

  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch {
    return null;
  }

  const cachedBeforeClaim = readCachedResult(cachePath);
  if (cachedBeforeClaim) return { cached: cachedBeforeClaim };

  let ownsLock = tryClaimCacheLock(lockPath);
  if (ownsLock === null) return { cached: null };
  if (!ownsLock) {
    const deadline = Date.now() + CHECK_CACHE_WAIT_MS;
    while (Date.now() < deadline) {
      const cached = readCachedResult(cachePath);
      if (cached) return { cached };
      if (!existsSync(lockPath)) {
        const retry = tryClaimCacheLock(lockPath);
        if (retry === true) {
          ownsLock = true;
          break;
        }
        if (retry === null) return { cached: null };
      }
      if (cacheLockIsStale(lockPath)) {
        removeCacheLock(lockPath);
        continue;
      }
      sleepSync(CHECK_CACHE_POLL_MS);
    }
    if (!ownsLock) {
      const cached = readCachedResult(cachePath);
      if (cached) return { cached };
      return { cached: null };
    }
  }

  // The owner may have written the cache between the first read and our
  // atomic claim. Prefer that result and release our temporary lock.
  const cachedAfterClaim = readCachedResult(cachePath);
  if (cachedAfterClaim) {
    removeCacheLock(lockPath);
    return { cached: cachedAfterClaim };
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    removeCacheLock(lockPath);
  };
  process.once('exit', release);

  return {
    cached: null,
    save(result) {
      const tempPath = `${cachePath}.${process.pid}.tmp`;
      try {
        writeFileSync(tempPath, JSON.stringify(result));
        renameSync(tempPath, cachePath);
      } catch {
        try {
          rmSync(tempPath, { force: true });
        } catch {
          // Optional cache only: the checker result remains authoritative.
        }
      }
    },
  };
}

function cleanupHeadSnapshot() {
  if (!HEAD_SNAPSHOT_ROOT) return;
  const root = HEAD_SNAPSHOT_ROOT;
  HEAD_SNAPSHOT_ROOT = null;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Lo snapshot è temporaneo e non deve trasformare un verdetto valido in
    // un errore se il sistema operativo lo sta ancora rilasciando.
  }
}

/**
 * Materializza il solo albero di codice del ref in un file temporaneo.
 * `git grep` ricrea un processo che può arrivare a centinaia di MB per ogni
 * token; un archive estratto una volta permette al pass lessicale di leggere
 * ogni file direttamente e poi rilasciarne il contenuto.
 *
 * Se archive/tar non sono disponibili, il chiamante usa il percorso Git
 * storico come fallback: la riduzione della memoria è opzionale, non cambia
 * il verdetto del checker.
 */
function createHeadSnapshot() {
  if (!HEAD_REF) return null;
  let root;
  let archiveFd;
  try {
    root = mkdtempSync(join(tmpdir(), 'frontaliere-sibling-patterns-'));
    const archivePath = join(root, 'tree.tar');
    archiveFd = openSync(archivePath, 'w');
    const archive = spawnSync(
      'git',
      ['archive', '--format=tar', HEAD_REF, '--', ...CODE_DIRS],
      { stdio: ['ignore', archiveFd, 'ignore'] },
    );
    closeSync(archiveFd);
    archiveFd = undefined;
    if (archive.error || archive.status !== 0) {
      throw archive.error ?? new Error('git archive failed');
    }

    const extracted = spawnSync(
      'tar',
      ['-xf', archivePath, '-C', root],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    if (extracted.error || extracted.status !== 0) {
      throw extracted.error ?? new Error('tar failed');
    }
    rmSync(archivePath, { force: true });
    HEAD_SNAPSHOT_ROOT = root;
    process.once('exit', cleanupHeadSnapshot);
    return root;
  } catch {
    if (archiveFd !== undefined) {
      try {
        closeSync(archiveFd);
      } catch {
        // Best effort: cleanup below covers the temporary directory.
      }
    }
    if (root) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Optional optimization only; Git fallback remains available.
      }
    }
    return null;
  }
}

/**
 * Build one bounded in-process search index for all needles and pattern
 * classes. It stores only file names (up to the existing noise caps), never
 * repository contents, so the scan has a predictable memory ceiling.
 */
function createSearchIndex(files, needles, excludedFiles) {
  if (HEAD_REF && !HEAD_SNAPSHOT_ROOT) return null;
  const fixedHits = new Map(
    [...new Set(needles)].map((needle) => [needle, []]),
  );
  const classStates = PATTERN_CLASSES.map((cls) => ({
    cls,
    prefilter: new RegExp(cls.prefilter, cls.prefilterFlags.includes('i') ? 'i' : ''),
    hits: [],
    active: true,
  }));

  for (const file of files) {
    const content = readTracked(file);
    if (content === null) continue;

    for (const [needle, hits] of fixedHits) {
      if (hits.length > MAX_FILES) continue;
      if (content.includes(needle)) hits.push(file);
    }

    for (const state of classStates) {
      if (
        !state.active ||
        excludedFiles.has(file) ||
        !state.prefilter.test(content)
      ) continue;
      if (state.cls.detect(content).length === 0) continue;
      state.hits.push(file);
      if (state.hits.length > MAX_PATTERN_CLASS_HITS) state.active = false;
    }
  }

  return {
    fixedHits,
    classHits: new Map(
      classStates.map((state) => [state.cls.name, state.active ? state.hits : []]),
    ),
  };
}

/**
 * `git grep -l` fallback for environments where the temporary snapshot
 * cannot be created. With the normal path the caller uses `createSearchIndex`
 * and this function is not invoked.
 */
function grepFiles(grepArgs, pathspecs) {
  const out = git(
    ['grep', ...grepArgs, ...(HEAD_REF ? [HEAD_REF] : []), '--', ...pathspecs],
    { allowFail: true },
  );
  const prefix = HEAD_REF ? `${HEAD_REF}:` : '';
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((l) => (prefix && l.startsWith(prefix) ? l.slice(prefix.length) : l));
}

/** Contenuto di un file tracked, dal ref se `--head` è attivo, altrimenti dal disco. */
function readTracked(file) {
  if (HEAD_REF && HEAD_SNAPSHOT_ROOT) {
    try {
      return readFileSync(join(HEAD_SNAPSHOT_ROOT, file), 'utf8');
    } catch {
      return null;
    }
  }
  if (!HEAD_REF) {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null; // deleted/binary/unreadable in working tree
    }
  }
  return git(['show', `${HEAD_REF}:${file}`], { allowFail: true }) || null;
}

function readTrackedAt(ref, file) {
  return git(['show', `${ref}:${file}`], { allowFail: true }) || null;
}

function astFactSignature(fact) {
  return JSON.stringify([
    fact.kind,
    fact.key,
    fact.role,
    fact.binding?.module ?? null,
    fact.binding?.imported ?? null,
    fact.fingerprint ?? null,
  ]);
}

/** List the code files that exist in the revision being inspected. */
function trackedCodeFiles() {
  const args = HEAD_REF
    ? ['ls-tree', '-r', '--name-only', HEAD_REF, '--', ...CODE_DIRS]
    : ['ls-files', '--', ...CODE_DIRS];
  return git(args, { allowFail: true })
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean)
    .filter(isCodeFile);
}

/**
 * Quanto è FORTE l'aggancio che ha portato dentro un candidato (2026-09-05).
 *
 * Misurato su questo repository (vedi PR che introduce questa funzione): su un
 * diff di UN file, 20 candidati su 22 erano agganciati a un solo identificatore
 * nudo — `rawDescription`, il nome di una variabile locale reimplementata in sei
 * job parser, e `completedAt`, un nome di campo presente in un pannello admin e
 * in una checklist. Gli unici due candidati seri condividevano un helper vero.
 * Un match su UN solo identificatore non è la stessa evidenza di un match su più
 * costrutti o su una forma strutturale del registro: chi legge l'elenco deve
 * poterlo distinguere a colpo d'occhio invece di ispezionare venti file per
 * trovarne due.
 *
 * `debole` NON significa «ignorabile»: il candidato resta nell'elenco e continua
 * a bloccare il gate (AGENTS.md #6 protegge una regola reale, e declassare a
 * silenzio aprirebbe un buco). È un ordinamento e un'etichetta, non un filtro.
 *
 * @param {string[]} tokens costrutti condivisi del candidato
 * @returns {'forte'|'debole'}
 */
export function candidateStrength(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  const structural = list.some((t) => t.startsWith('class:"'));
  if (structural) return 'forte';
  // AST labels explain the same lexical construct; they must not turn one
  // identifier into two independent signals. A resolved graph binding is
  // independent evidence and is therefore strong on its own.
  if (list.some((t) => t.startsWith('graph:'))) return 'forte';
  // A removed expression is useful historical evidence, but unlike a
  // resolved binding it is not independent proof: a generic line can be
  // reimplemented in many unrelated files. Keep it visible while preventing
  // a removed-only hit from being presented as a strong sibling.
  const lexical = list.filter(
    (t) => !t.startsWith('ast:') && !t.startsWith('graph:') && !t.startsWith('removed:"'),
  );
  return lexical.length >= 2 ? 'forte' : 'debole';
}

function resolveBase() {
  if (BASE_ARG) return BASE_ARG;
  for (const ref of ['origin/main', 'main']) {
    if (git(['rev-parse', '--verify', '--quiet', ref], { allowFail: true }).trim()) {
      return ref;
    }
  }
  return 'HEAD~1';
}

// resolveMergeBase / formatUnresolvableMergeBaseMessage: see
// scripts/ci/lib/resolve-merge-base.mjs (issue #5195 — shared with
// check-below-floor-bridge.mjs, which had the same verbatim antipattern).

/**
 * Estrae espressioni verbatim dalle righe RIMOSSE del diff (prefisso `-`).
 * Pass supplementare rispetto a extractTokens (issue #4260): quando un fix
 * introduce un helper NUOVO, i gemelli non lo importano ancora → token-match
 * non li vede. Questo pass li trova cercando l'espressione verbatim con
 * `git grep -F` (stessa soglia MAX_FILES del token-match).
 *
 * Criteri di selezione:
 *   - Linea che inizia con `-` (non `---` header)
 *   - Contenuto ≥20 e ≤120 caratteri dopo strip
 *   - NON è una riga di commento (`//`, `*`, `#`)
 *   - NON è una riga di import/require/export-declaration
 *   - Contiene almeno un pattern codice: chiamata `ident(` o assign `ident:`
 *   - Trailing `,;` rimosso prima del confronto
 */
const GENERIC_REMOVED_GUARD_PATTERNS = Object.freeze([
  /^\s*if\s*\(\s*!?(?:res|response)\.ok\b[^)]*\)\s*return\b/i,
  /^\s*if\s*\([^)]*\btypeof\s+(?:html|body|rawHtml)\s*!==?\s*['"]string['"][^)]*\)\s*return\b/i,
]);

export function isGenericRemovedExpression(expression) {
  const value = String(expression || '');
  return GENERIC_REMOVED_GUARD_PATTERNS.some((pattern) => pattern.test(value));
}

export function extractRemovedExpressions(diffText) {
  const exprs = new Set();
  for (const line of diffText.split('\n')) {
    if (!line.startsWith('-') || line.startsWith('---')) continue;
    const content = line.slice(1).trim();
    if (!content) continue;
    // Skip comment lines
    if (/^(\/\/|\/\*|\*[\s/]|#)/.test(content)) continue;
    // Skip import/require/export-declaration lines (surface too broad)
    if (/\b(import\s|require\s*\(|export\s+(default\s+)?(function|class|const|let|var)\b)/.test(content)) continue;
    // Must look like a code expression: function call or property assignment
    if (!/[a-zA-Z_$][a-zA-Z0-9_$]*\s*[(:]/.test(content)) continue;
    // Strip trailing punctuation
    const cleaned = content.replace(/[,;]\s*$/, '').trim();
    if (cleaned.length >= 20 && cleaned.length <= 120) {
      // These guards are ubiquitous transport/input boilerplate. They were
      // promoted as "strong" siblings by the verbatim pass even when the
      // diff changed an unrelated domain rule (observed on PR #9501). Keep
      // the pass for semantic expressions, but do not turn generic plumbing
      // into a repository-wide sibling sweep.
      if (isGenericRemovedExpression(cleaned)) continue;
      exprs.add(cleaned);
    }
  }
  return exprs;
}

/**
 * Estrae token distintivi da un blocco di righe diff (contenuto +/-).
 * Quattro classi, ciascuna scelta perché identifica un costrutto CONDIVISIBILE
 * tra gemelli (non rumore generico):
 *   - COST SCREAMING_SNAKE (≥1 underscore): es. SPA_BUNDLE_RX, POST_WALK_WORKERS.
 *   - helper camelCase/PascalCase distintivi (≥8 char, mixedCase): es.
 *     truncateSlugAtWordBoundary, resolveSearchConsoleCompatTarget.
 *   - basename kebab-case in import/require (≥1 hyphen): es.
 *     compat-paths-floor-guard, slug-truncate (idiomi condivisi via modulo).
 *   - literal kebab-case string VALUE (non solo import path — issue #3658:
 *     un id/slug condiviso come valore letterale, es. `'anna-keller-wyss'` in
 *     un registro AUTHORS mirrorato in due script, non veniva mai estratto
 *     perché non compare dentro un path di import). Soglia lunghezza ≥10 per
 *     escludere parole composte comuni corte (es. `'max-age'`); MAX_FILES a
 *     valle scarta comunque i match troppo diffusi.
 */
export function extractTokens(text) {
  const tokens = new Set();

  // SCREAMING_SNAKE_CASE con almeno un underscore, lunghezza ≥5.
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) {
    const t = m[0];
    if (t.length >= 5 && !STOP.has(t)) tokens.add(t);
  }

  // camelCase / PascalCase distintivi: ≥8 char, almeno una transizione di case.
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9]*\b/g)) {
    const t = m[0];
    if (t.length < 8 || STOP.has(t)) continue;
    const mixed = /[a-z][A-Z]/.test(t) || /[A-Z][a-z].*[A-Z]/.test(t);
    if (mixed) tokens.add(t);
  }

  // basename kebab-case in stringhe di import/require/from.
  for (const m of text.matchAll(/['"`][^'"`]*?\/([a-z0-9]+(?:-[a-z0-9]+)+)(?:\.[a-z]+)?['"`]/g)) {
    const t = m[1];
    if (t.length >= 5) tokens.add(t);
  }

  // Valore letterale kebab-case standalone (l'intera stringa quotata, non un
  // segmento di path): un id/slug condiviso come valore, non come import.
  for (const m of text.matchAll(/['"`]([a-z0-9]+(?:-[a-z0-9]+)+)['"`]/g)) {
    const t = m[1];
    if (t.length >= 10 && !t.includes('/')) tokens.add(t);
  }

  return tokens;
}

/**
 * ─── Pattern-class registry (issue #4260 escalation, round 2) ─────────────
 *
 * extractTokens/extractRemovedExpressions above are LEXICAL: they need a
 * literal token or expression shared between the diff and a sibling file.
 * The `sibling-class-fix` bucket kept recurring past that pass (6× in 14
 * days: #4252, #4224, #4221, #4200, #4199) because the repeat findings are a
 * different SHAPE of gap — the SAME bug logic re-implemented with different
 * variable/helper names, so there is no shared token to grep for. A curated
 * registry of a FEW known recurring bug shapes closes part of that gap: each
 * entry below is a heuristic detector (regex-based "AST-lite", not a real
 * parser) that scans file CONTENT for the shape, independent of what the
 * current diff happens to touch. Like the token/verbatim passes, this is a
 * candidate-surfacer — a match means "worth a human look", not "confirmed
 * bug". Keep this registry SMALL and each detector NARROW (verified against
 * the live repo — see docs/AGENTS-HISTORY.md#sibling-pattern-fix for the
 * false-positive rates measured while calibrating each one): a detector that
 * fires on a large fraction of matching files is noise, not signal.
 */

/**
 * "cap-before-mutation" (worked example: issue #4208, scatter-jobs-to-slices
 * `collectMissingAssembledBridges` — headroom computed from a job's CURRENT
 * slug set, then a later step in the same pass renames/rewrites that same
 * slug set without recomputing headroom against the post-mutation state).
 *
 * Heuristic: find a `const/let <cap|headroom|floor>Var = … - <obj>.length`
 * (or `.size`) computation, then look ONLY forward in the same file for a
 * mutation of that SAME base object (`obj.push(`/`obj.splice(`/index or
 * property assignment, or `obj` passed into a rename/rewrite/mutate-named
 * call) before the cap variable is ever recomputed. Deliberately narrow:
 * requires the literal base-object identifier to reappear, so it only
 * catches the case where cap and mutation share an identifier — it will NOT
 * catch the case where the cap is derived from one variable and the
 * mutation lands on an unrelated clone (the real #4208 shape after its
 * fix moved to a journal-backed helper). That is an accepted false-negative
 * for a lexical heuristic; expand the registry with a second, more specific
 * detector if another concrete incident of that broader shape recurs.
 */
export function detectCapBeforeMutation(text) {
  const findings = [];
  const capRx =
    /\b(?:const|let)\s+(\w*(?:[Cc]ap|[Hh]eadroom|[Ff]loor)\w*)\s*=\s*(?:Math\.(?:max|min)\([^,]*,\s*)?[\w.]+\s*-\s*(?:\w+\.)*(\w+)\.(?:length|size)\b/g;
  let m;
  while ((m = capRx.exec(text)) !== null) {
    const [full, capVar, baseObj] = m;
    const windowStart = m.index + full.length;
    const window = text.slice(windowStart, windowStart + 4000);
    const mutateRx = new RegExp(
      `\\b${baseObj}\\.(?:push|splice|unshift|pop|shift)\\(` +
        `|\\b${baseObj}\\[[^\\]]*\\]\\s*=(?!=)` +
        `|\\b${baseObj}\\.\\w+\\s*=(?!=)` +
        `|\\b\\w*(?:[Rr]ename|[Rr]ewrite|[Mm]utate)\\w*\\([^)]*\\b${baseObj}\\b`,
    );
    const mutateMatch = mutateRx.exec(window);
    if (!mutateMatch) continue;
    // Cap recomputed before the mutation runs → the shape is safe, skip.
    const recomputeRx = new RegExp(`\\b${capVar}\\s*=`);
    if (recomputeRx.test(window.slice(0, mutateMatch.index))) continue;
    findings.push({ index: m.index, snippet: full.trim() });
  }
  return findings;
}

/**
 * "closeBundle-ordering" (worked example: issue #4263 item 4 — a Rollup
 * plugin's `closeBundle` hook does `existsSync`/`readFileSync` against a
 * dist-output path a DIFFERENT plugin may or may not have written yet,
 * without declaring `sequential: true` — Rollup runs `closeBundle` hooks
 * async/parallel by default, so the read races the sibling plugin's write).
 *
 * Heuristic: find a `closeBundle(`/`closeBundle:` hook; bail out entirely
 * if the file declares `sequential: true` anywhere (the established fix,
 * see `hreflangPostprocessPlugin.ts`). Otherwise, inside the hook, track
 * path variables built by joining `distDir`/`outDir` with a NON-literal
 * segment (a per-item/per-URL variable, not a hardcoded filename — a
 * hardcoded name under `distDir` is almost always the plugin's OWN
 * artifact, e.g. `sitemap-annual-report.xml`, not a sibling's). Flag if one
 * of those derived paths is read via `existsSync`/`readFileSync`. Bare
 * `existsSync(distDir)`/`existsSync(outDir)` (the ubiquitous "did the build
 * even produce a dist dir" bail-out) is deliberately excluded — it is not
 * itself a cross-plugin read and flagging it made this detector fire on
 * over half the files that use `closeBundle` (measured while calibrating —
 * narrowed to the dynamic-path-only form above, see AGENTS-HISTORY.md).
 */
export function detectCloseBundleOrdering(text) {
  const findings = [];
  if (/\bsequential\s*:\s*true\b/.test(text)) return findings;
  const cbRx = /\bcloseBundle\s*[:(]/g;
  let m;
  while ((m = cbRx.exec(text)) !== null) {
    const windowStart = m.index;
    const window = text.slice(windowStart, windowStart + 50000);

    // Track path vars built from distDir/outDir (or from another already-
    // discovered path var) with a non-literal joined segment — up to 3
    // passes to follow a couple of levels of derivation.
    const rootNames = new Set(['distDir', 'outDir']);
    const discovered = new Set();
    for (let pass = 0; pass < 3; pass++) {
      const before = discovered.size;
      const namesAlt = [...rootNames, ...discovered].join('|');
      // Capture the char right after the comma (if a quote/backtick) instead
      // of a negative lookahead: `\s*` before a lookahead can backtrack past
      // the intended anchor point and let a literal ('index.html') slip
      // through as if it were a dynamic segment. An explicit optional
      // capture group has no failure path to backtrack from, so it reports
      // the actual next-non-space char reliably.
      const declRx = new RegExp(
        `\\b(?:const|let)\\s+(\\w+)\\s*=\\s*path\\.(?:join|resolve)\\(\\s*(?:${namesAlt})\\s*,\\s*(['"\`]?)[^;\\n]*\\);`,
        'g',
      );
      let d;
      while ((d = declRx.exec(window)) !== null) {
        if (d[2]) continue; // literal segment (quoted string) — not dynamic
        discovered.add(d[1]);
      }
      if (discovered.size === before) break;
    }

    let hit = null;
    for (const v of discovered) {
      const readRx = new RegExp(
        `\\b(?:existsSync|readFileSync)\\(\\s*(?:path\\.(?:join|resolve)\\(\\s*)?${v}\\b`,
      );
      const rm = readRx.exec(window);
      if (rm) {
        hit = rm[0];
        break;
      }
    }
    if (hit) findings.push({ index: windowStart, snippet: hit });
  }
  return findings;
}

/**
 * "persist-time-country-stamp" (worked example: issue #5403/#5384, PR series
 * #5423/#5419/#5405/#5390/#5378 — five review rounds across five PRs before
 * this converged, which is what triggered escalation #5426). A crawler/
 * pipeline script forges `addressCountry = 'CH'` onto a job record BEFORE it
 * is persisted to the indexed dataset, destroying the "field not declared by
 * the source" vs "field declared CH" distinction that downstream consumers
 * (`services/seoService.ts`, `components/community/JobBoard.tsx`,
 * `build-plugins/jobsSeoPagesPlugin.ts`) rely on via a safe read-time
 * fallback (`job.addressCountry || 'CH'`). The token/verbatim passes above
 * missed every sibling in that series because each script re-implements the
 * stamp with its own object identifier and no shared helper/constant to
 * grep for — reviewers noted explicitly in PR #5405/#5390 that
 * `check-sibling-patterns.mjs --strict` did not flag the sibling.
 *
 * Heuristic: an assignment `<expr>.addressCountry = 'CH'` (unconditional OR
 * inside an `if (!<expr>.addressCountry)` guard — both forms were flagged;
 * the guard does not change the textual assignment substring) in a file
 * that also persists JSON to disk (`writeJson(`, `writeJsonAtomic(`, or
 * `writeFileSync(` — the call that turns an in-memory stamp into forged
 * evidence on `data/jobs.json`/`public/data/jobs.json`). Literal `'CH'`
 * only (not a generic literal-to-field regex): the established SAFE idiom
 * at read-time consumption sites is always an expression fallback
 * (`||`/`??`), never an assignment back onto the field, so this shape does
 * not fire there; restricting to the literal also avoids a verified false
 * positive on `` `addressCountry="${addr.addressCountry}"` `` style error-
 * message template strings in `validate-jobposting-schema.mjs`/
 * `audit-dist-multi.mjs`, which are not assignments but read the same way
 * to a naive `\.addressCountry\s*=` regex.
 */
export function detectPersistTimeCountryStamp(text) {
  const findings = [];
  if (!/\bwriteJson(?:Atomic)?\s*\(|\bwriteFileSync\s*\(/.test(text)) return findings;
  const rx = /\b[\w.[\]'"]*\.addressCountry\s*=\s*(['"])CH\1/g;
  let m;
  while ((m = rx.exec(text)) !== null) {
    findings.push({ index: m.index, snippet: m[0].trim() });
  }
  return findings;
}

/**
 * The registry itself: name + one-line description (surfaced to the user)
 * + a cheap `prefilter` (passed to `git grep -l` to shrink the file set
 * before the more expensive per-file `detect()` regex runs) + the detector.
 */
export const PATTERN_CLASSES = [
  {
    name: 'cap-before-mutation',
    description:
      'cap/headroom/floor calcolato da un oggetto, poi lo STESSO oggetto mutato dopo senza ricalcolo (issue #4208)',
    prefilter: '(headroom|floor|\\bcap\\b)',
    prefilterFlags: '-liE',
    detect: detectCapBeforeMutation,
  },
  {
    name: 'closeBundle-ordering',
    description:
      "closeBundle legge l'output dist di un altro plugin senza `sequential: true` (issue #4263 item 4)",
    prefilter: 'closeBundle\\s*[:(]',
    prefilterFlags: '-lE',
    detect: detectCloseBundleOrdering,
  },
  {
    name: 'persist-time-country-stamp',
    description:
      "addressCountry forgiato a 'CH' prima di un writeJson/writeFileSync, stessa evidenza distrutta della serie #5403/#5384 (escalation #5426)",
    prefilter: '\\.addressCountry\\s*=',
    prefilterFlags: '-lE',
    detect: detectPersistTimeCountryStamp,
  },
];

function emitReport({ base, changedFiles, changedCode, candidates }) {
  const result = { base, head: HEAD_REF, changedFiles, changedCode, candidates };
  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(STRICT && candidates.length ? 1 : 0);
  }

  console.log(`check-sibling-patterns — base ${base}${HEAD_REF ? ` · head ${HEAD_REF}` : ''}`);
  console.log(`File di codice cambiati: ${changedCode.length}`);
  if (candidates.length === 0) {
    console.log(
      '✓ Nessun file gemello non-toccato condivide i costrutti modificati. ' +
        'Sweep di classe verosimilmente completo (verifica comunque i casi strutturali ' +
        'che il token-match non cattura, es. guard mancante in un twin).',
    );
    process.exit(0);
  }

  console.log(
    `\n⚠ ${candidates.length} file gemello/i NON toccato/i condivide/ono costrutti che il tuo diff ha modificato.`,
  );
  console.log(
    'Ispeziona ognuno: ha lo STESSO antipattern? → includi il fix nella STESSA PR ' +
      '(AGENTS.md #6) oppure giustificalo in `## Non implementato`.\n',
  );
  const weak = candidates.filter((c) => c.strength === 'debole').length;
  for (const c of candidates) {
    console.log(`  [${c.strength}] ${c.file}`);
    console.log(`      costrutti condivisi: ${c.tokens.join(', ')}`);
  }
  console.log(
    '\nNB: candidate-surfacer euristico — token condivisi ≠ stesso antipattern. ' +
      'Conferma a mano prima di toccare/giustificare.',
  );
  if (weak) {
    console.log(
      `[debole] = agganciato a UN solo identificatore nudo (${weak}/${candidates.length} qui). ` +
        'Storicamente la gran parte di questi è rumore: un nome di variabile o di campo ' +
        'reimplementato in file scorrelati. Vanno comunque guardati, ma parti dai [forte].',
    );
  }
  process.exit(STRICT ? 1 : 0);
}

function main() {
  const base = resolveBase();
  // merge-base per il three-dot: cambiamenti del branch dalla divergenza.
  const resolution = resolveMergeBase(base, HEAD_REF ?? 'HEAD');
  const { mergeBase } = resolution;

  if (!mergeBase) {
    // Issue #5195: niente fallback silenzioso su `base` — su un clone shallow
    // quel fallback confrontava alberi non imparentati e produceva centinaia
    // di falsi positivi (ogni file che differisce da `base`, non solo quelli
    // del branch). Bail-out esplicito invece: candidate-surfacer inattendibile
    // è peggio di nessun candidate-surfacer.
    //
    // Ma «esplicito» ≠ `exit 0`: con exit 0 il pre-push hook passava e la PR
    // si apriva senza che NESSUN sibling fosse stato guardato, indistinguibile
    // da uno sweep pulito. Skip ⇒ blocco (override deliberato via
    // CI_ALLOW_UNRESOLVED_MERGE_BASE), e il banner va su stderr perché in
    // --json lo stdout è già impegnato dal report che il chiamante parsa.
    const verdict = formatUnresolvableMergeBaseVerdict('check-sibling-patterns', base, resolution);
    process.stderr.write(verdict.banner);
    if (JSON_OUT) {
      console.log(
        JSON.stringify(
          { base, head: HEAD_REF, mergeBase: null, changedFiles: 0, changedCode: [], candidates: [], skipped: true, reason: 'unresolvable-merge-base' },
          null,
          2,
        ),
      );
    }
    process.exit(STRICT && verdict.blocking ? 1 : 0);
  }

  // Senza `--head`: diff del working tree vs base (committed + staged +
  // unstaged), che copre tutto ciò che il branch introdurrà anche se il fixer
  // non ha ancora committato. Con `--head <ref>`: diff commit-a-commit, quindi
  // il verdetto dipende dal BRANCH e non dalla directory da cui giriamo (pass 8).
  const changedRaw = git(
    ['diff', '--name-only', '--diff-filter=ACMR', mergeBase, ...(HEAD_REF ? [HEAD_REF] : [])],
    { allowFail: true },
  );
  const changedAll = changedRaw.split('\n').map((s) => s.trim()).filter(Boolean);
  const changedCode = changedAll.filter(isCodeFile);
  const changedSet = new Set(changedAll);

  // `changedFiles` NON e' `changedAll.length`. Il diff sopra filtra `ACMR`
  // perche' l'analisi dei gemelli ha bisogno di file che ESISTONO da leggere;
  // ma il numero che il gate usa per rispondere «ho analizzato il branch
  // giusto?» deve rispondere a «il ref differisce dalla base?», non a «il ref
  // aggiunge file?». Senza questa seconda misura un branch di sole
  // cancellazioni (script morto, workflow ritirato, revert) produce
  // `changedFiles: 0` con un ref perfettamente corretto, e
  // `sibling-check-gate.mjs` lo blocca stampando tre cause tutte false —
  // l'autore ha gia' fatto tutto e non ha nessuna leva per soddisfare il gate.
  // E' la stessa classe di blocco insoddisfacibile che questa PR chiude
  // altrove, reintrodotta dal suo stesso fix. `D` deve contare.
  const changedAnyRaw = git(
    ['diff', '--name-only', mergeBase, ...(HEAD_REF ? [HEAD_REF] : [])],
    { allowFail: true },
  );
  const changedFiles = changedAnyRaw.split('\n').map((s) => s.trim()).filter(Boolean).length;

  if (changedCode.length === 0) {
    const msg =
      'check-sibling-patterns: nessun file di codice funnel-critical cambiato vs ' +
      `${base} — niente da analizzare.`;
    if (JSON_OUT)
      console.log(
        JSON.stringify(
          { base, head: HEAD_REF, changedFiles, changedCode: [], candidates: [] },
          null,
          2,
        ),
      );
    else console.log(msg);
    process.exit(0);
  }

  // Deduplicate immutable branch checks before doing any content sweep. This
  // lets concurrent gates wait for the result without each starting its own
  // Git/parser workload.
  const headCache = createHeadCache(base, mergeBase);
  if (headCache?.cached) emitReport(headCache.cached);

  // Raccoglie i token distintivi dalle righe cambiate e le espressioni rimosse.
  // L'AST layer filtra i token che hanno una forma strutturale: un nome in un
  // commento o in una stringa non basta più a far entrare un candidato. I
  // nomi di variabili locali senza una forma strutturale utile vengono scartati
  // del tutto: sono il principale generatore di falsi positivi del pass
  // lessicale storico. Slug/config literal vengono letti come fatti AST; i
  // token senza fatti restano sul percorso lessicale solo per file non
  // analizzabili dal parser (shell/YAML-like).
  const tokenToChangedFiles = new Map(); // token -> Set(file che l'ha cambiato)
  const astFactsByToken = new Map(); // token -> facts AST presenti nelle righe aggiunte
  const astParsedTokens = new Set(); // token seen in a parser-backed changed source
  const removedExprs = new Set(); // espressioni verbatim da righe `-` (pass #6)
  const astFiles = new Set([...trackedCodeFiles(), ...changedCode]);
  for (const file of changedCode) {
    const diff = git(
      ['diff', '--unified=0', mergeBase, ...(HEAD_REF ? [HEAD_REF] : []), '--', file],
      { allowFail: true },
    );
    const touched = diff
      .split('\n')
      .filter((l) => (l.startsWith('+') || l.startsWith('-')) && !/^(\+\+\+|---)/.test(l))
      .map((l) => l.slice(1))
      .join('\n');
    const changedTokens = extractTokens(touched);
    for (const tok of changedTokens) {
      if (!tokenToChangedFiles.has(tok)) tokenToChangedFiles.set(tok, new Set());
      tokenToChangedFiles.get(tok).add(file);
    }

    const source = readTracked(file);
    if (isAstSourceFile(file)) {
      for (const tok of changedTokens) astParsedTokens.add(tok);
    }
    const changedRanges = diffLineRanges(diff, 'new');
    if (source && changedRanges.length > 0) {
      const changedFacts = collectAstFacts(file, source, {
        lineRanges: changedRanges,
        files: astFiles,
      });
      const baseSource = readTrackedAt(mergeBase, file);
      const baseFacts = baseSource
        ? collectAstFacts(file, baseSource, { files: astFiles })
        : [];
      const unchangedFacts = new Set(baseFacts.map(astFactSignature));
      for (const tok of changedTokens) {
        const facts = factsContainingToken(changedFacts, tok);
        if (facts.length === 0) continue;
        if (!astFactsByToken.has(tok)) astFactsByToken.set(tok, []);
        astFactsByToken.get(tok).push(
          ...facts
            .filter(isActionableAstFact)
            .filter((fact) => !unchangedFacts.has(astFactSignature(fact))),
        );
      }
    }
    // Pass verbatim: raccogli espressioni significative dalle sole righe rimosse
    for (const expr of extractRemovedExpressions(diff)) {
      removedExprs.add(expr);
    }
  }

  if (tokenToChangedFiles.size === 0 && removedExprs.size === 0) {
    const msg =
      'check-sibling-patterns: nessun costrutto distintivo (costante/​helper/​modulo) ' +
      'estratto dalle righe cambiate — niente classe di pattern da sweepare.';
    if (JSON_OUT)
      console.log(
        JSON.stringify(
          { base, head: HEAD_REF, changedFiles, changedCode, candidates: [] },
          null,
          2,
        ),
      );
    else console.log(msg);
    process.exit(0);
  }

  // A --head scan reads a single temporary tree instead of asking Git to
  // rescan the object database once per token. Working-tree checks read the
  // already tracked files directly and keep the same file boundaries.
  createHeadSnapshot();
  const searchIndex = createSearchIndex(
    astFiles,
    [...tokenToChangedFiles.keys(), ...removedExprs],
    changedSet,
  );

  // Collect lexical evidence without retaining repository contents. The
  // expensive full-file work happens below, once per candidate file.
  const candidateTokens = new Map(); // file -> Set(token condiviso)
  const addCandidateToken = (file, token) => {
    let tokens = candidateTokens.get(file);
    if (!tokens) {
      tokens = new Set();
      candidateTokens.set(file, tokens);
    }
    tokens.add(token);
  };
  const pathspecs = [...CODE_DIRS, ...EXCLUDE_PATHSPECS];
  const filesContaining = (needle) => searchIndex?.fixedHits.get(needle) ??
    grepFiles(['-l', '--fixed-strings', '-e', needle], pathspecs);
  for (const [tok, srcFiles] of tokenToChangedFiles) {
    const hits = filesContaining(tok);
    if (hits.length > MAX_FILES) continue; // troppo comune → rumore
    for (const f of hits) {
      if (changedSet.has(f)) continue; // già nel branch
      if (!isCodeFile(f)) continue;
      // ignora self-match dei file sorgente del token (sono già changed)
      if (srcFiles.has(f)) continue;
      addCandidateToken(f, tok);
    }
  }

  // Pass verbatim (issue #4260): cerca le espressioni rimosse nei gemelli.
  // Stessa soglia MAX_FILES del token-match (15): il caso motivante di questo
  // pass — PR #4224, `description: copy.description` verbatim in 14 sibling
  // non-guardati — verrebbe scartato come "rumore" da una soglia più stretta,
  // mentre è esattamente la classe di bug più ampia da sweepare (reviewer
  // finding PR #4272 round 1).
  for (const expr of removedExprs) {
    const hits = filesContaining(expr);
    if (hits.length > MAX_FILES) continue; // troppo comune → rumore
    for (const f of hits) {
      if (changedSet.has(f)) continue;
      if (!isCodeFile(f)) continue;
      const label = `removed:"${expr.length > 50 ? expr.slice(0, 47) + '…' : expr}"`;
      addCandidateToken(f, label);
    }
  }

  // Match AST evidence after the lexical pass, once per candidate file. The
  // previous implementation cached every parsed sibling for the whole run;
  // this keeps only the current source/facts live and preserves the exact
  // token-level filtering semantics above.
  for (const [file, tokens] of candidateTokens) {
    const astChecks = [];
    for (const token of tokens) {
      if (!tokenToChangedFiles.has(token)) continue;
      const changedFacts = astFactsByToken.get(token);
      if (changedFacts?.length) {
        astChecks.push([token, changedFacts]);
      } else if (changedFacts || astParsedTokens.has(token)) {
        // A parser-backed token with no actionable fact is deliberately not
        // allowed to fall back to lexical matching.
        tokens.delete(token);
      }
    }

    if (astChecks.length > 0) {
      const source = readTracked(file);
      const factKeys = new Set();
      for (const [, changedFacts] of astChecks) {
        for (const fact of changedFacts) {
          factKeys.add(`${fact.kind}|${fact.key}|${fact.role}`);
          if (fact.kind === 'identifier' && fact.role === 'declaration' && fact.exported) {
            for (const role of ['call', 'reference', 'declaration']) {
              factKeys.add(`${fact.kind}|${fact.key}|${role}`);
            }
          }
        }
      }
      const candidateFacts = source
        ? collectAstFacts(file, source, {
          files: astFiles,
          candidateOnly: true,
          factKeys,
        })
        : [];
      for (const [token, changedFacts] of astChecks) {
        const astMatches = matchAstFacts(changedFacts, candidateFacts);
        if (astMatches.length === 0) {
          tokens.delete(token);
          continue;
        }
        for (const label of astMatchLabels(astMatches)) tokens.add(label);
      }
    }

    if (tokens.size === 0) candidateTokens.delete(file);
  }

  // Pattern-class registry (issue #4260 escalation, round 2): indipendente
  // dal diff, scansiona TUTTI i file gemelli tracked (non toccati dal
  // branch) per le forme di bug curate in PATTERN_CLASSES. A differenza dei
  // pass sopra, non serve un token/espressione condivisa col diff — solo la
  // STESSA forma strutturale, anche con nomi di variabile diversi.
  for (const cls of PATTERN_CLASSES) {
    const files = searchIndex?.classHits.get(cls.name) ??
      grepFiles([cls.prefilterFlags, cls.prefilter], pathspecs);
    // Collect first, merge only if under the cap — a misfiring detector
    // should not contribute partial noise just because it fired early.
    const classHits = [];
    if (searchIndex) {
      classHits.push(...files);
    } else {
      for (const f of files) {
        if (changedSet.has(f)) continue;
        if (!isCodeFile(f)) continue;
        const content = readTracked(f);
        if (content === null) continue; // deleted/binary/unreadable — skip
        if (cls.detect(content).length === 0) continue;
        classHits.push(f);
        if (classHits.length > MAX_PATTERN_CLASS_HITS) break; // stop early, too broad to be useful
      }
    }
    if (classHits.length > MAX_PATTERN_CLASS_HITS) continue; // detector misfiring broadly → drop this class for this run
    for (const f of classHits) {
      if (!candidateTokens.has(f)) candidateTokens.set(f, new Set());
      candidateTokens.get(f).add(`class:"${cls.name}"`);
    }
  }

  const candidates = [...candidateTokens.entries()]
    .map(([file, toks]) => {
      const tokens = [...toks].sort();
      return { file, tokens, strength: candidateStrength(tokens) };
    })
    // Forti prima: chi legge l'elenco deve incontrare per primi i candidati con
    // più evidenza, non un blocco di agganci a token singolo (2026-09-05).
    .sort(
      (a, b) =>
        (a.strength === b.strength ? 0 : a.strength === 'forte' ? -1 : 1) ||
        b.tokens.length - a.tokens.length ||
        a.file.localeCompare(b.file),
    );

  const result = { base, head: HEAD_REF, changedFiles, changedCode, candidates };
  headCache?.save?.(result);
  emitReport(result);
}

// Only run when executed directly (e.g. as a PreToolUse hook), not on import.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main();
}
