// Raccoglie da git i fatti che le regole di scripts/lib/branch-purge-policy.mjs
// trasformano in prove: "il contenuto di questo worktree è già su main, o su
// GitHub dentro una PR". Nessuna decisione qui, solo letture: il runner `git`
// è iniettato, così lo stesso codice gira nello sweep e nei test.
//
// Costo: ogni lettura pesante è per PR (indice dei patch-id, file dello
// squash, merge) o per finestra di main, ed è memorizzata; la catena locale e
// la PR hanno un tetto oltre il quale la prova non si tenta (= report-only).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

import { DELETED, isCommitContained, isDirtyContained, isMergeContained } from './branch-purge-policy.mjs';
import { classifyDirtyEntries } from './worktree-dirty.mjs';

const DEFAULT_LIMITS = Object.freeze({
  chain: 120, // commit locali non in PR né su main
  prCommits: 400, // commit propri della PR candidata
  windowCommits: 600, // commit first-parent di main in una finestra
  probes: 200000, // righe `<commit>:<path>` per un solo cat-file
});

// `git log -p` deterministico: prefissi espliciti (diff.noPrefix e
// diff.mnemonicPrefix dell'utente cambierebbero i patch-id), niente rename
// (ogni file ha il suo pezzo), niente colori o diff esterni.
const PATCH_OPTS = ['--no-color', '--no-ext-diff', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/'];

export function makeGitRunner(cwd) {
  return function git(args, { input, maxBuffer = 512 * 1024 * 1024 } = {}) {
    try {
      return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
        cwd,
        input,
        encoding: 'utf8',
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
        maxBuffer,
      });
    } catch {
      return null;
    }
  };
}

// Id del blob git di un contenuto (SHA-1, il formato di questo repo). Nessun
// filtro di checkout: `.gitattributes` qui ha solo `merge=union`. Con un filtro
// il blob non combacerebbe e il worktree resterebbe: l'errore va dal lato sicuro.
export function gitBlobId(buffer) {
  return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
}

export function workingBlob(fullPath) {
  let st;
  try { st = lstatSync(fullPath); } catch (e) { return e?.code === 'ENOENT' ? DELETED : null; }
  try {
    if (st.isSymbolicLink()) return gitBlobId(Buffer.from(readlinkSync(fullPath)));
    if (st.isFile()) return gitBlobId(readFileSync(fullPath));
  } catch { return null; }
  return null; // directory al posto di un file (submodule, cartella): non confrontabile
}

// `git log -p` / `git diff` → un pezzo per file. Il path viene dalle righe
// `---`/`+++` (col prefisso tolto), o dall'intestazione se il cambio è solo di
// modo. Un pezzo binario non ha un patch-id affidabile.
export function splitFileChunks(patchText) {
  const chunks = [];
  let commit = null;
  let cur = null;
  const close = () => {
    if (cur) {
      cur.path = cur.path || cur.oldPath || cur.headerPath;
      chunks.push(cur);
    }
    cur = null;
  };
  for (const line of String(patchText || '').split('\n')) {
    const header = /^commit ([0-9a-f]{40})$/.exec(line);
    if (header) { close(); commit = header[1]; continue; }
    if (line.startsWith('diff --git ')) {
      close();
      const paths = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      cur = { commit, path: null, oldPath: null, headerPath: paths && paths[1] === paths[2] ? paths[1] : null, lines: [line], binary: false };
      continue;
    }
    if (!cur) continue;
    cur.lines.push(line);
    if (!cur.path && line.startsWith('+++ b/')) cur.path = line.slice(6);
    else if (!cur.oldPath && line.startsWith('--- a/')) cur.oldPath = line.slice(6);
    if (line === 'GIT binary patch' || /^Binary files .* differ$/.test(line)) cur.binary = true;
  }
  close();
  return chunks;
}

export function makeContentProver({ git, mainRef, limits = {} }) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const memo = new Map();
  const cached = (key, fn) => {
    if (!memo.has(key)) memo.set(key, fn());
    return memo.get(key);
  };
  const out = (args, opts) => git(args, opts);
  const ok = (args) => out(args) !== null;

  const hasCommit = (rev) => Boolean(rev) && cached(`has:${rev}`, () => ok(['cat-file', '-e', `${rev}^{commit}`]));
  const isAncestor = (a, b) => ok(['merge-base', '--is-ancestor', a, b]);
  const treeOf = (rev) => cached(`tree:${rev}`, () => (out(['rev-parse', '--verify', '-q', `${rev}^{tree}`]) || '').trim() || null);
  const mergeBase = (a, b) => (out(['merge-base', a, b]) || '').trim() || null;
  const onMain = (rev) => isAncestor(rev, mainRef);

  // `merge-tree --write-tree` esce 1 sui conflitti: lì il runner dà null.
  function mergeTree(base, ours, theirs) {
    const res = out(['merge-tree', '--write-tree', `--merge-base=${base}`, ours, theirs]);
    return res === null ? null : (res.split('\n')[0] || '').trim() || null;
  }

  function patchIds(chunks) {
    const ids = new Array(chunks.length).fill(null);
    const parts = [];
    chunks.forEach((chunk, i) => {
      if (!chunk.binary) parts.push(`commit ${i.toString(16).padStart(40, '0')}\n${chunk.lines.join('\n')}\n`);
    });
    if (!parts.length) return ids;
    for (const line of (out(['patch-id', '--stable'], { input: parts.join('') }) || '').split('\n')) {
      const [pid, id] = line.split(' ');
      if (pid && id) ids[Number.parseInt(id, 16)] = pid;
    }
    return ids;
  }

  // Tutto ciò che serve sapere di una PR, letto una volta: i patch-id dei suoi
  // file, i file del suo squash, i suoi merge per genitori.
  function prIndex(head) {
    return cached(`pr:${head}`, () => {
      const count = Number.parseInt(out(['rev-list', '--count', '--no-merges', head, '--not', mainRef]) || '', 10);
      if (!Number.isFinite(count) || count > L.prCommits) return null;
      const chunks = splitFileChunks(out(['log', '-p', ...PATCH_OPTS, '--no-merges', '--format=commit %H', head, '--not', mainRef]) || '');
      const pids = new Set(patchIds(chunks).filter(Boolean));
      const base = mergeBase(mainRef, head);
      const squashFiles = new Set(base
        ? (out(['diff', '--name-only', '--no-renames', '-z', base, head]) || '').split('\0').filter(Boolean)
        : []);
      const merges = new Map();
      for (const row of (out(['rev-list', '--merges', '--parents', head, '--not', mainRef]) || '').split('\n')) {
        const [sha, ...parents] = row.split(' ');
        if (sha && parents.length) merges.set(parents.join(' '), sha);
      }
      return { pids, squashFiles, merges, tree: treeOf(head) };
    });
  }

  function commitFacts(sha, parent, head, idx) {
    if (treeOf(sha) === treeOf(parent)) return { empty: true };
    const own = splitFileChunks(out(['log', '-p', ...PATCH_OPTS, '--format=commit %H', '-1', sha]) || '');
    const ownIds = patchIds(own);
    const files = own.map((chunk, i) => ({
      path: chunk.path,
      binary: chunk.binary,
      matched: Boolean(ownIds[i]) && idx.pids.has(ownIds[i]),
      inSquash: idx.squashFiles.has(chunk.path),
    }));
    if (files.length && files.every((f) => f.matched && !f.binary)) {
      // Il revert: l'inverso esatto di ogni file non deve essere un commit della PR.
      const inverse = splitFileChunks(out(['diff', ...PATCH_OPTS, sha, parent]) || '');
      const invIds = patchIds(inverse);
      const revertedPaths = new Set(inverse.filter((_, i) => invIds[i] && idx.pids.has(invIds[i])).map((c) => c.path));
      for (const f of files) f.inverseMatched = revertedPaths.has(f.path);
      if (isCommitContained({ files })) return { files };
    }
    const absorbedTree = mergeTree(parent, head, sha);
    if (absorbedTree && absorbedTree === idx.tree) return { absorbed: true };
    return { files };
  }

  // Il contenuto del ramo `tip` è dentro l'HEAD `head` di una PR?
  //   1. tip antenato di head;
  //   2. la catena locale (commit non in head e non su main), riapplicata
  //      in blocco su head dal punto di biforcazione, non cambia l'albero;
  //   3. ogni commit della catena è contenuto (isCommitContained) o è un merge
  //      rifatto che differisce dal gemello della PR solo in file generati.
  // Ritorna anche se una parte della storia locale è nella PR: la base
  // dell'annotazione "probabile superato" quando la prova non c'è.
  function proveChain(tip, head) {
    if (!tip || !head || !hasCommit(tip) || !hasCommit(head)) return { proven: false, reason: 'commit non presente in locale' };
    if (isAncestor(tip, head)) return { proven: true, how: 'antenato dell\'HEAD della PR' };
    const raw = out(['rev-list', '--parents', `--max-count=${L.chain + 1}`, tip, '--not', head, mainRef]);
    if (raw === null) return { proven: false, reason: 'rev-list fallito' };
    const chain = raw.split('\n').filter(Boolean).map((row) => {
      const [sha, ...parents] = row.split(' ');
      return { sha, parents };
    });
    if (chain.length === 0) return { proven: true, how: 'antenato dell\'HEAD della PR' };
    if (chain.length > L.chain) return { proven: false, reason: `oltre ${L.chain} commit locali` };
    const fork = mergeBase(tip, head);
    const sharesPr = Boolean(fork) && !onMain(fork);
    if (fork && !chain.some((c) => c.parents.length > 1)) {
      const net = mergeTree(fork, head, tip);
      if (net && net === treeOf(head)) return { proven: true, how: `${chain.length} commit già nell'albero della PR`, sharesPr };
    }
    const idx = prIndex(head);
    if (!idx) return { proven: false, reason: `PR oltre ${L.prCommits} commit`, sharesPr, unproven: chain.length, example: chain[0].sha };
    let byPatch = 0;
    let byTwin = 0;
    for (let i = 0; i < chain.length; i++) {
      const { sha, parents } = chain[i];
      let contained;
      if (parents.length > 1) {
        const twin = idx.merges.get(parents.join(' '));
        const twinDiff = twin ? (out(['diff', '--name-only', '--no-renames', '-z', twin, sha]) || '').split('\0').filter(Boolean) : null;
        contained = isMergeContained({ twinDiff });
        if (contained) byTwin++;
      } else if (parents.length === 1) {
        const facts = commitFacts(sha, parents[0], head, idx);
        contained = isCommitContained(facts);
        if (contained && facts.files) byPatch++;
      } else {
        contained = false; // commit radice: niente con cui confrontarlo
      }
      if (!contained) return { proven: false, reason: 'commit senza equivalente nella PR', sharesPr, unproven: chain.length - i, example: sha };
    }
    const detail = [
      byPatch ? `${byPatch} per patch-id, revert esclusi` : '',
      byTwin ? `${byTwin} merge rifatti uguali al gemello della PR salvo file generati` : '',
    ].filter(Boolean).join('; ');
    return { proven: true, how: `${chain.length} commit equivalenti a commit della PR${detail ? ` (${detail})` : ''}`, sharesPr };
  }

  // Stato sporco di un worktree, completo: ogni file non tracciato (anche dentro
  // cartelle nuove) e il percorso esatto (-z). Il rumore (output di cron, body
  // della PR se la PR esiste) è escluso come nel resto dello sweep.
  function dirtyEntries(wtPath, { prExists }) {
    const raw = out(['--no-optional-locks', '-C', wtPath, 'status', '--porcelain', '-z', '--untracked-files=all']);
    if (raw === null) return null;
    const entries = [];
    const fields = raw.split('\0');
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (field.length < 4) continue;
      const status = field.slice(0, 2);
      entries.push({ status, path: field.slice(3) });
      if (/[RC]/.test(status)) i++; // il path d'origine segue come campo a sé
    }
    return classifyDirtyEntries(entries, { prExists }).significantEntries;
  }

  // Versioni locali di ogni path sporco: working tree e index.
  function localVersions(wtPath, entries) {
    const index = new Map();
    const paths = entries.map((e) => e.path);
    const raw = paths.length ? out(['-C', wtPath, 'ls-files', '-s', '-z', '--', ...paths]) : '';
    if (raw === null) return null;
    for (const row of raw.split('\0').filter(Boolean)) {
      const match = /^(\d+) ([0-9a-f]+) (\d)\t(.+)$/.exec(row);
      if (!match) return null;
      if (match[3] !== '0') return null; // conflitto non risolto: non si confronta
      index.set(match[4], match[2]);
    }
    return entries.map((e) => {
      const working = workingBlob(join(wtPath, e.path));
      return { ...e, versions: [working, index.get(e.path) || DELETED], complete: working !== null };
    });
  }

  function blobsAt(rev, paths) {
    const map = new Map();
    if (!paths.length) return map;
    const raw = out(['ls-tree', '-z', rev, '--', ...paths]);
    if (raw === null) return null;
    for (const row of raw.split('\0').filter(Boolean)) {
      const match = /^\d+ \w+ ([0-9a-f]+)\t(.+)$/.exec(row);
      if (match) map.set(match[2], match[1]);
    }
    return map;
  }

  // Blob che ogni path ha avuto nei commit di un intervallo (`base..head`).
  function blobsInRange(rangeArgs, paths) {
    const map = new Map(paths.map((p) => [p, new Set()]));
    const raw = out(['log', '--format=commit %H', '--raw', '-z', '--no-abbrev', '--no-renames', '--diff-merges=first-parent', ...rangeArgs, '--', ...paths]);
    if (raw === null) return null;
    // Con -z: ":<mm> <mm> <src> <dst> <S>\0<path>\0"
    const fields = raw.split('\0');
    for (let i = 0; i < fields.length; i++) {
      const match = /:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(fields[i]);
      if (!match) continue;
      const filePath = fields[i + 1];
      i++;
      if (!map.has(filePath)) continue;
      map.get(filePath).add(match[5] === 'D' ? DELETED : match[4]);
    }
    return map;
  }

  // A3 / riapplicazione: lo sporco tracciato è identico al blob dello stesso
  // path in un commit tra la base del worktree e l'HEAD della PR. Un file non
  // tracciato fa fallire la prova; quelli tutti sotto `tmp/` diventano
  // un'annotazione (A4), non una rimozione.
  function dirtyProof(wtPath, head, prHead, { prExists = true } = {}) {
    const entries = dirtyEntries(wtPath, { prExists });
    if (entries === null) return { proven: false, reason: 'stato git illeggibile' };
    if (entries.length === 0) return { proven: true, clean: true };
    const untracked = entries.filter((e) => e.status === '??');
    if (untracked.length) {
      const tmpOnly = untracked.every((e) => e.path.startsWith('tmp/')) && untracked.length === entries.length;
      return { proven: false, reason: `${untracked.length} file non tracciati`, tmpOnly: tmpOnly ? untracked.length : 0 };
    }
    const local = localVersions(wtPath, entries);
    if (!local || local.some((e) => !e.complete)) return { proven: false, reason: 'versioni locali illeggibili' };
    const base = mergeBase(head, prHead);
    const paths = local.map((e) => e.path);
    const atHead = blobsAt(head, paths);
    const inRange = base ? blobsInRange([`${base}..${prHead}`], paths) : null;
    if (!atHead || !inRange) return { proven: false, reason: 'storia della PR illeggibile' };
    const withAllowed = local.map((e) => ({
      ...e,
      allowed: new Set([atHead.get(e.path) || DELETED, ...inRange.get(e.path)]),
    }));
    return isDirtyContained(withAllowed)
      ? { proven: true, files: local.length }
      : { proven: false, reason: 'sporco diverso dai blob della PR' };
  }

  function firstParentWindow(sinceMs, untilMs) {
    const raw = out(['rev-list', '--first-parent', `--max-count=${L.windowCommits + 1}`,
      `--since=${Math.floor(sinceMs / 1000)}`, `--until=${Math.floor(untilMs / 1000)}`, mainRef]);
    if (raw === null) return null;
    const commits = raw.split('\n').filter(Boolean);
    return commits.length > L.windowCommits ? null : commits;
  }

  // `<commit>:<path>` per ogni coppia, in un solo cat-file. null = troppo grande
  // o illeggibile.
  function probe(pairs) {
    if (!pairs.length) return [];
    if (pairs.length > L.probes || pairs.some(([, p]) => p.includes('\n'))) return null;
    const raw = out(['cat-file', '--batch-check=%(objectname)'], { input: `${pairs.map(([c, p]) => `${c}:${p}`).join('\n')}\n` });
    if (raw === null) return null;
    const lines = raw.split('\n');
    return pairs.map((_, i) => {
      const line = lines[i] || '';
      return /^[0-9a-f]{40}$/.test(line) ? line : DELETED;
    });
  }

  // C2: un worktree sporco che è solo un vecchio checkout di main. Cerca UN
  // commit first-parent di main (nella finestra intorno all'ultima scrittura
  // dell'index) che spieghi tutti i file sporchi, non tracciati compresi.
  function staleMainCheckout(wtPath, head, { aroundMs, spanMs = 24 * 60 * 60 * 1000, prExists = false } = {}) {
    const entries = dirtyEntries(wtPath, { prExists });
    if (!entries || entries.length === 0) return { proven: false };
    if (entries.some((e) => /[RC]/.test(e.status))) return { proven: false };
    const local = localVersions(wtPath, entries);
    if (!local || local.some((e) => !e.complete)) return { proven: false };
    const paths = local.map((e) => e.path);
    const atHead = blobsAt(head, paths);
    const window = firstParentWindow(aroundMs - spanMs, aroundMs + spanMs);
    if (!atHead || !window || !window.length) return { proven: false };
    const blobs = probe(window.flatMap((c) => paths.map((p) => [c, p])));
    if (!blobs) return { proven: false };
    for (let w = 0; w < window.length; w++) {
      const withAllowed = local.map((e, i) => ({
        ...e,
        allowed: new Set([atHead.get(e.path) || DELETED, blobs[w * paths.length + i]]),
      }));
      if (isDirtyContained(withAllowed, { allowUntracked: true })) return { proven: true, commit: window[w], files: local.length };
    }
    return { proven: false };
  }

  // C1: i file di una directory orfana sono tutti in main? Prima l'albero di
  // main, poi la storia first-parent nella finestra: lo stato all'inizio della
  // finestra più ogni blob scritto dai suoi commit. Un blob raggiungibile solo
  // da un commit fuori da main non conta.
  function mainTreeBlobs() {
    return cached('main-tree', () => {
      const raw = out(['ls-tree', '-r', '-z', mainRef]);
      if (raw === null) return null;
      const map = new Map();
      for (const row of raw.split('\0').filter(Boolean)) {
        const match = /^\d+ \w+ ([0-9a-f]+)\t(.+)$/.exec(row);
        if (match) map.set(match[2], match[1]);
      }
      return map;
    });
  }

  function orphanFilesMatch(files, { sinceMs, untilMs }) {
    const main = mainTreeBlobs();
    if (!main) return null;
    const matched = new Map();
    const pending = [];
    for (const f of files) {
      if (main.get(f.rel) === f.blob) matched.set(f.rel, true);
      else pending.push(f);
    }
    if (pending.length) {
      const window = firstParentWindow(sinceMs, untilMs);
      if (window && window.length) {
        const oldest = window[window.length - 1];
        const paths = pending.map((f) => f.rel);
        const atStart = probe(paths.map((p) => [oldest, p]));
        const changed = blobsInRange(['--first-parent', `--since=${Math.floor(sinceMs / 1000)}`,
          `--until=${Math.floor(untilMs / 1000)}`, mainRef], paths);
        if (atStart && changed) {
          pending.forEach((f, i) => {
            if (atStart[i] === f.blob || changed.get(f.rel)?.has(f.blob)) matched.set(f.rel, true);
          });
        }
      }
    }
    return matched;
  }

  // Paths ignorati dalle regole di .gitignore del checkout corrente.
  function ignoredPaths(cwdRoot, rels) {
    if (!rels.length) return new Set();
    const raw = out(['-C', cwdRoot, 'check-ignore', '--stdin', '-z'], { input: `${rels.join('\0')}\0` });
    return new Set((raw || '').split('\0').filter(Boolean));
  }

  return {
    hasCommit,
    isAncestor,
    onMain,
    proveChain,
    dirtyProof,
    staleMainCheckout,
    orphanFilesMatch,
    ignoredPaths,
  };
}

// Il `.git` di un worktree: file `gitdir: <path>`. Puntatore a un gitdir sparito
// = residuo, non lavoro.
export function isDanglingGitPointer(fullPath) {
  try {
    const st = lstatSync(fullPath);
    if (!st.isFile()) return false;
    const match = /^gitdir: (.+)$/m.exec(readFileSync(fullPath, 'utf8'));
    return Boolean(match) && !existsSync(match[1].trim());
  } catch {
    return false;
  }
}
