/**
 * sibling-checker-revision.mjs — quale `check-sibling-patterns.mjs` deve
 * eseguire `sibling-check-gate.mjs`.
 *
 * Il gate analizzava gia' il BRANCH proposto (`--head <ref>`), ma lo faceva con
 * il checker che stava accanto al gate stesso: il WORKING TREE del checkout da
 * cui l'hook era stato lanciato. Nella flotta quel checkout e' spesso quello
 * principale, fermo sul branch di un'altra sessione. Misurato il 2026-10-04
 * (consegna NX-SEO-06): checkout principale su un branch basato su un main del
 * 2026-09-08, checker con diff +72/-747 rispetto a `origin/main`. Il checker
 * vecchio produceva candidati che quello attuale, eseguito sullo stesso ref, non
 * vedeva (0 candidati): un blocco che nessuna dichiarazione poteva sciogliere,
 * perche' i candidati non esistevano per il codice che l'autore stava
 * proponendo.
 *
 * Regola: il verdetto dipende da una REVISIONE, mai da un working tree.
 *   1. il checker della revisione giudicata (il commit di `--head`), se la
 *      contiene: e' lo stesso codice che la CI eseguirebbe su quel branch;
 *   2. altrimenti quello di `origin/main`;
 *   3. solo se nessuna delle due revisioni contiene il checker (repository di
 *      prova, ref estranei) quello locale, dichiarato come tale nel messaggio.
 *
 * Il checker di una revisione viene estratto da Git (file d'ingresso piu' la
 * chiusura dei suoi import relativi) in una directory di cache indirizzata per
 * contenuto, con un symlink `node_modules` verso quello del checkout del gate,
 * cosi' gli import di pacchetto (`typescript`) si risolvono come prima. Il
 * checker gira poi con la cwd di sempre: e' quella, non la sua posizione sul
 * disco, a scegliere il repository analizzato.
 *
 * `describeCheckerDivergence` rende visibile ogni differenza fra il checker
 * usato e quello di `origin/main`, con gli hash dei blob: una divergenza deve
 * comparire nel messaggio, non sotto forma di candidati fantasma.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';

/** Revisione di riferimento del checker quando la revisione giudicata non lo contiene. */
export const CHECKER_BASE_REF = 'origin/main';

const BLOB_CONTENT = new Map();

const RELATIVE_IMPORT_RE =/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"\n]+)\1/g;

/**
 * Specificatori relativi importati da un modulo (statici, dinamici con
 * literal, side-effect). Un falso positivo (un import citato in un commento)
 * non e' un problema: un path che non esiste nella revisione viene saltato.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function relativeImports(source) {
  const specs = new Set();
  for (const match of String(source ?? '').matchAll(RELATIVE_IMPORT_RE)) specs.add(match[2]);
  return [...specs];
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function revParse(cwd, spec) {
  try {
    return git(cwd, ['rev-parse', '--verify', '--quiet', spec]).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Il checker di una revisione: file d'ingresso e chiusura degli import
 * relativi, letti da Git (mai dal disco). `undefined` se il ref non risolve o
 * non contiene il file d'ingresso.
 *
 * @param {string|undefined} cwd directory del repository in cui eseguire git
 * @param {string} ref
 * @param {string} entry path del checker relativo alla radice del repository
 * @returns {{ref:string, commit:string, entry:string,
 *   files:{path:string, blob:string, content:string}[]}|undefined}
 */
export function readRevisionChecker(cwd, ref, entry) {
  const commit = revParse(cwd, `${ref}^{commit}`);
  if (!commit) return undefined;
  const files = [];
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    // `<commit>:<path>` e' relativo alla radice dell'albero, qualunque sia la cwd.
    const blob = revParse(cwd, `${commit}:${path}`);
    if (!blob) {
      if (path === entry) return undefined;
      continue;
    }
    // Un blob gia' letto (la revisione giudicata e origin/main condividono di
    // solito quasi tutto il checker) non si rilegge: in un clone parziale
    // `cat-file` di un blob assente andrebbe in rete dentro un hook.
    let content = BLOB_CONTENT.get(blob);
    if (content === undefined) {
      try {
        content = git(cwd, ['cat-file', 'blob', blob]);
      } catch {
        return undefined;
      }
      BLOB_CONTENT.set(blob, content);
    }
    files.push({ path, blob, content });
    for (const spec of relativeImports(content)) {
      const next = posix.normalize(posix.join(posix.dirname(path), spec));
      if (!next.startsWith('..')) queue.push(next);
    }
  }
  return { ref, commit, entry, files };
}

/** Impronta stabile di un checker: path e blob di ogni file della chiusura. */
export function checkerFingerprint(snapshot) {
  return (snapshot?.files ?? [])
    .map((file) => `${file.path}:${file.blob}`)
    .sort()
    .join('\n');
}

/**
 * Scrive il checker di una revisione in una directory di cache indirizzata per
 * contenuto e restituisce il path assoluto del file d'ingresso. La directory
 * viene preparata a parte e rinominata in modo atomico: hook paralleli vedono
 * un checker completo o nessuno.
 *
 * @param {{entry:string, files:{path:string, blob:string, content:string}[]}} snapshot
 * @param {{nodeModules?:string, cacheRoot?:string}} [options]
 * @returns {string}
 */
export function materializeChecker(snapshot, options = {}) {
  const nodeModules = options.nodeModules && existsSync(options.nodeModules) ? options.nodeModules : '';
  const requestedRoot = options.cacheRoot ?? join(tmpdir(), 'frontaliere-sibling-gate-checker');
  mkdirSync(requestedRoot, { recursive: true });
  // realpath: su macOS tmpdir passa per il symlink /var → /private/var. Il
  // checker riconosce l'esecuzione diretta confrontando import.meta.url (gia'
  // risolto) con argv[1]: un path non risolto lo farebbe uscire senza output.
  const cacheRoot = realpathSync(requestedRoot);
  const key = createHash('sha256')
    .update(`${checkerFingerprint(snapshot)}\n${nodeModules}`)
    .digest('hex')
    .slice(0, 24);
  const root = join(cacheRoot, key);
  const entryPath = join(root, snapshot.entry);
  const marker = join(root, '.complete');
  if (existsSync(marker)) return entryPath;

  const staging = mkdtempSync(join(cacheRoot, `${key}.tmp-`));
  try {
    for (const file of snapshot.files) {
      const target = join(staging, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, 'utf8');
    }
    if (nodeModules) symlinkSync(nodeModules, join(staging, 'node_modules'), 'dir');
    writeFileSync(join(staging, '.complete'), '', 'utf8');
    try {
      renameSync(staging, root);
    } catch (error) {
      // Un hook concorrente ha gia' pubblicato lo stesso contenuto.
      if (!existsSync(marker)) throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return entryPath;
}

function localBlob(file) {
  try {
    return execFileSync('git', ['hash-object', '--', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * I checker da provare, in ordine di preferenza: revisione giudicata, poi
 * `origin/main`, poi quello locale. Un checker identico al precedente non viene
 * ripetuto. Ogni voce porta l'impronta che serve a `describeCheckerDivergence`.
 *
 * @param {{cwd?:string, headRef:string, entry:string, localCheckScript:string,
 *   localRepo:string, baseRef?:string, cacheRoot?:string}} options
 * @returns {{sources:{kind:'judged'|'base'|'local', label:string, script:string,
 *   snapshot?:object}[], base:object|undefined, errors:string[]}}
 */
export function checkerCandidates({
  cwd,
  headRef,
  entry,
  localCheckScript,
  localRepo,
  baseRef = CHECKER_BASE_REF,
  cacheRoot,
}) {
  const nodeModules = join(localRepo, 'node_modules');
  const sources = [];
  const errors = [];
  const judged = readRevisionChecker(cwd, headRef, entry);
  const base = readRevisionChecker(cwd, baseRef, entry);
  const add = (kind, snapshot, label) => {
    if (!snapshot) return;
    if (sources.some((s) => s.snapshot && checkerFingerprint(s.snapshot) === checkerFingerprint(snapshot))) return;
    try {
      sources.push({ kind, label, snapshot, script: materializeChecker(snapshot, { nodeModules, cacheRoot }) });
    } catch (error) {
      errors.push(`${label}: estrazione fallita (${error?.message ?? error})`);
    }
  };
  if (judged) add('judged', judged, `revisione giudicata ${headRef} @ ${judged.commit.slice(0, 10)}`);
  if (base) add('base', base, `${baseRef} @ ${base.commit.slice(0, 10)}`);
  sources.push({ kind: 'local', label: `working tree locale ${localCheckScript}`, script: localCheckScript });
  return { sources, base, errors };
}

function shortBlob(blob) {
  return blob ? blob.slice(0, 10) : 'assente';
}

/**
 * Riga (o righe) da mettere nel messaggio del gate quando il checker usato non
 * coincide con quello di `origin/main`; `undefined` quando coincide.
 *
 * @param {{kind:string, label:string, script:string, snapshot?:object}} used
 * @param {{entry:string, files:{path:string, blob:string}[]}|undefined} base
 * @param {{localRepo?:string, entry?:string, baseRef?:string}} [options]
 * @returns {string|undefined}
 */
export function describeCheckerDivergence(used, base, options = {}) {
  const baseRef = options.baseRef ?? CHECKER_BASE_REF;
  if (!used) return undefined;
  if (used.kind === 'local') {
    const entry = options.entry ?? base?.entry ?? 'scripts/ci/check-sibling-patterns.mjs';
    const localHash = localBlob(used.script);
    const baseHash = base?.files.find((f) => f.path === entry)?.blob;
    return (
      `checker usato: ${used.label} — NON una revisione (` +
      `${used.fallbackReason ? `checker delle revisioni falliti: ${used.fallbackReason}` : `né la revisione giudicata né ${baseRef} contengono ${entry}`}).\n` +
      `  ${entry}: blob locale ${shortBlob(localHash)}, ${baseRef} ${shortBlob(baseHash)}` +
      `${localHash && localHash === baseHash ? ' (file d\'ingresso identico)' : ''}`
    );
  }
  if (!base || used.kind === 'base') return undefined;
  const ours = new Map(used.snapshot.files.map((f) => [f.path, f.blob]));
  const theirs = new Map(base.files.map((f) => [f.path, f.blob]));
  const paths = [...new Set([...ours.keys(), ...theirs.keys()])].sort();
  const differing = paths.filter((p) => ours.get(p) !== theirs.get(p));
  if (!differing.length) return undefined;
  return (
    `checker usato: ${used.label} — DIVERSO da quello di ${baseRef} @ ${base.commit.slice(0, 10)}.\n` +
    differing
      .map((p) => `  ${p}: blob ${shortBlob(ours.get(p))} (usato) vs ${shortBlob(theirs.get(p))} (${baseRef})`)
      .join('\n')
  );
}
