/**
 * Guard: una run di Vitest non può lasciare modificato un file TRACCIATO.
 *
 * AGENTS.md lo dice da tempo («Un test non scrive MAI in un file tracciato»),
 * ma nessuno lo verificava. Il 2026-09-30 `tests/pharmacy-atomic-workflow.test.ts`
 * eseguiva per davvero `scripts/import-pharmacy-duties-swiss-cantons.mjs` (rete
 * compresa) e riscriveva `data/pharmacy-duties-swiss-cantons.json` e
 * `data/pharmacy-sources-registry.json` nel checkout a ogni corsa: in locale
 * quei due file finivano nel `git status` di chiunque lanciasse i test, pronti
 * per un `git add -A`, e in CI il test dipendeva dalla rete e dal dato del giorno.
 *
 * Il controllo è una FOTOGRAFIA prima/dopo, non un divieto sulle singole API:
 * vede anche le scritture fatte da processi figli (bash, git, script Node) che
 * nessun hook su `fs` dentro il worker intercetterebbe. Lo stato è l'elenco dei
 * file tracciati sporchi (`git status --porcelain -z --untracked-files=no`) con
 * l'hash del contenuto: un file già modificato prima della run (lavoro in corso,
 * oppure l'assemble/migrate che in CI precede Vitest) resta fuori finché la run
 * non lo cambia ancora.
 *
 * Unica eccezione: in modalità aggiornamento degli snapshot (`vitest -u`) i
 * file `__snapshots__/*.snap` cambiano per scelta di chi lancia il comando.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Legge l'output di `git status --porcelain=v1 -z` e restituisce i path del
 * working tree coinvolti. Per rename e copie (`R`/`C`) il formato -z mette il
 * path nuovo e poi quello vecchio: contano entrambi.
 *
 * @param {string} porcelain
 * @returns {string[]}
 */
export function parsePorcelainZ(porcelain) {
  const fields = String(porcelain || '').split('\0');
  const paths = [];
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (status.includes('R') || status.includes('C')) {
      const previous = fields[i + 1];
      if (previous) paths.push(previous);
      i += 1;
    }
  }
  return paths;
}

/**
 * Fotografia dei file tracciati sporchi: path → hash del contenuto nel working
 * tree (`missing` se il file non c'è più).
 *
 * @param {string} root radice del repo
 * @param {{ git?: (args: string[]) => string }} [deps]
 * @returns {Map<string, string> | null} null se `git` non è utilizzabile
 */
export function snapshotTrackedState(root, deps = {}) {
  const git = deps.git ?? ((args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }));
  let porcelain;
  try {
    porcelain = git(['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules']);
  } catch {
    return null;
  }
  const state = new Map();
  for (const rel of parsePorcelainZ(porcelain)) {
    const abs = path.join(root, rel);
    state.set(rel, existsSync(abs)
      ? createHash('sha1').update(readFileSync(abs)).digest('hex')
      : 'missing');
  }
  return state;
}

const SNAPSHOT_RE = /(^|\/)__snapshots__\/[^/]+\.snap$/;

/**
 * I file che la run ha modificato: sporchi dopo ma non prima, oppure sporchi
 * in entrambe le fotografie con un contenuto diverso. Un file tornato pulito
 * non conta: il working tree è come prima.
 *
 * @param {Map<string, string>} before
 * @param {Map<string, string>} after
 * @param {{ allowSnapshotUpdates?: boolean }} [options]
 * @returns {string[]}
 */
export function trackedChanges(before, after, options = {}) {
  const changed = [];
  for (const [rel, hash] of after) {
    if (before.get(rel) === hash) continue;
    if (options.allowSnapshotUpdates && SNAPSHOT_RE.test(rel)) continue;
    changed.push(rel);
  }
  return changed.sort();
}

/**
 * Il messaggio del rosso: quali file, perché è vietato, cosa fare.
 *
 * @param {string[]} changed
 * @returns {string}
 */
export function formatTrackedChanges(changed) {
  const list = changed.slice(0, 30).map((rel) => `  - ${rel}`).join('\n');
  const more = changed.length > 30 ? `\n  … e altri ${changed.length - 30}` : '';
  return [
    `tracked-files-guard: la run di Vitest ha modificato ${changed.length} file ${changed.length === 1 ? 'tracciato' : 'tracciati'}:`,
    `${list}${more}`,
    '',
    'Un test non scrive MAI in un file tracciato (AGENTS.md): redirigi l\'output in os.tmpdir()',
    'e parametrizza il path via env, oppure fai girare lo script sotto test in una directory',
    'temporanea. Per trovare il test, rilancia i candidati uno alla volta e guarda `git status`.',
    'Ripristina i file con `git checkout -- <path>` se non contengono lavoro tuo.',
  ].join('\n');
}
