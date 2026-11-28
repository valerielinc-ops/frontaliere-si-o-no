#!/usr/bin/env node
/**
 * Dice se la differenza `<baseSha>..<head>` tocca un file che entra nell'hash
 * della chiave esatta `assemble-jobs-<os>-<hash>`.
 *
 * Quella chiave e' l'hash di TUTTI gli input dell'assemblatore calcolato
 * sull'albero di merge (`computeAssembleInputFingerprint`): se la PR modifica
 * anche un solo file compreso, nessuna run di main sulla base puo' produrre la
 * stessa chiave e attendere che la pubblichi e' un'attesa certamente inutile.
 *
 * L'insieme e' ESATTAMENTE quello che la funzione hasha: le tre directory di
 * slice (solo i figli diretti che passano `isSliceFile`), la chiusura degli
 * import (`listAssembleCodeClosure`) e `ASSEMBLE_AUX_DATA_INPUTS` (file esatti,
 * oppure directory per prefisso con separatore). Gli OUTPUT (data/jobs.json...)
 * non entrano nella chiave e quindi non sono qui.
 *
 * Uso: node scripts/ci/assemble-key-inputs-changed.mjs <baseSha> [head=HEAD]
 * Stampa una riga JSON `{"changed":bool,"path":string|null}`; exit != 0 su
 * qualunque errore (il chiamante decide il fail-open).
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSliceFile } from '../lib/crawler-slice-files.mjs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Specchio delle tre costanti `*_SLICES_DIR` di assemble-jobs-dataset.mjs, che
// non le esporta; tests/ci/assemble-key-inputs-changed.test.ts ne verifica la
// presenza nel sorgente dell'assemblatore.
export const ASSEMBLE_SLICE_DIRS = Object.freeze([
  'data/jobs/by-crawler',
  'data/jobs/expired/by-crawler',
  'data/jobs-crawler-summaries/by-crawler',
]);

/**
 * @param {object} args
 * @param {string[]} args.changedPaths  path relativi alla radice, con `/`
 * @param {string[]} args.codeFiles     chiusura del codice, relativi alla radice
 * @param {readonly string[]} args.auxInputs  file o directory (prefisso)
 * @param {readonly string[]} [args.sliceDirs]
 * @returns {{changed: boolean, path: string|null}}
 */
export function findChangedAssembleKeyInput({
  changedPaths,
  codeFiles,
  auxInputs,
  sliceDirs = ASSEMBLE_SLICE_DIRS,
}) {
  const code = new Set(codeFiles);
  const aux = new Set(auxInputs);
  for (const file of changedPaths) {
    const slash = file.lastIndexOf('/');
    const dir = slash === -1 ? '' : file.slice(0, slash);
    const base = file.slice(slash + 1);
    const hit = code.has(file)
      || aux.has(file)
      || auxInputs.some((entry) => file.startsWith(`${entry}/`))
      || (sliceDirs.includes(dir) && isSliceFile(base));
    if (hit) return { changed: true, path: file };
  }
  return { changed: false, path: null };
}

function git(args) {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

export async function probeAssembleKeyInputsChanged(baseSha, head = 'HEAD') {
  if (!/^[0-9a-f]{40}$/i.test(String(baseSha || ''))) {
    throw new Error(`base SHA non valido: ${baseSha}`);
  }
  const assembler = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'assemble-jobs-dataset.mjs')).href);
  const codeFiles = assembler.listAssembleCodeClosure()
    .map((abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/'));
  const changedPaths = git(['diff', '--name-only', '--no-renames', '-z', baseSha, head])
    .split('\0')
    .filter(Boolean);
  return findChangedAssembleKeyInput({
    changedPaths,
    codeFiles,
    auxInputs: assembler.ASSEMBLE_AUX_DATA_INPUTS,
  });
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    const result = await probeAssembleKeyInputsChanged(process.argv[2], process.argv[3] || 'HEAD');
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`assemble-key-inputs-changed: ${error.message}\n`);
    process.exit(1);
  }
}
