/**
 * identical-twin-import-gate.mjs — cancello di PR: un gemello `identical` non
 * acquista un import relativo verso un file che il corpus non avra'.
 *
 * ## Il guasto che chiude
 *
 * La #9887 (2026-09-25) ha spostato le costanti di
 * `scripts/ci/claude-codex-fallback.mjs`, gemello `identical`, nel modulo nuovo
 * `scripts/lib/codex-fallback-contract.mjs`, che il manifest di sync del corpus
 * non elencava. Il trasporto delle 04:47 UTC del 26/09 ha portato l'importatore
 * senza il modulo: PR corpus #1890 rossa su 30 file di test con
 * `ERR_MODULE_NOT_FOUND`, trasporto giornaliero fermo dietro il guard «PR di
 * trasporto gia' in volo», e al merge si sarebbe rotto anche il review gate del
 * corpus. Riparato a mano con la PR corpus #1892.
 *
 * Il guard esisteva gia': `undeclaredRelativeImports()` in
 * `corpus-ahead-check.mjs`. Ma gira una volta al giorno alle 08:47 UTC e commenta
 * la issue cumulativa #6369: ha visto il pericolo quattro ore DOPO che il
 * trasporto aveva aperto la #1890. Questo file pone la stessa domanda, con la
 * stessa funzione, nel momento in cui il pericolo nasce: la PR del sito.
 *
 * ## Cosa blocca e cosa no
 *
 * - Blocca un pericolo INTRODOTTO dalla PR: presente su HEAD e assente sulla
 *   base, fra quelli in cui l'importatore o il file importato cambia nella PR.
 *   Sul checkout di `tests.yml` HEAD e' `refs/pull/N/merge`, quindi `HEAD^1` e'
 *   la punta di main.
 * - Un pericolo gia' presente sulla base resta un `::warning::`. Bloccarlo
 *   renderebbe rossa ogni PR che tocca quel gemello per un difetto che non ha
 *   introdotto; peggio, una voce tolta dal manifest del CORPUS renderebbe rosse
 *   tutte le PR del sito senza che nessuna abbia cambiato niente. Quei casi
 *   restano del controllo giornaliero.
 * - Manifest del corpus illeggibile o base non risolvibile: `::warning::` ed
 *   exit 0. Fail-closed qui fermerebbe ogni PR del sito per un'indisponibilita'
 *   di raw.githubusercontent.com; la rete di sicurezza resta
 *   `corpus-ahead-check.yml`.
 *
 * Costo: i gemelli si leggono dal checkout (o da `git show HEAD:` se lo sparse
 * non li ha); la base si legge solo per i pochi pericoli candidati, perche' il
 * checkout di CI e' `filter: tree:0` e ogni oggetto assente e' un fetch.
 *
 * Uso:
 *   node scripts/ci/identical-twin-import-gate.mjs                     # base = HEAD^1
 *   node scripts/ci/identical-twin-import-gate.mjs --base origin/main  # base esplicita
 *   node scripts/ci/identical-twin-import-gate.mjs --manifest <file>   # manifest locale, senza rete
 *
 * Env: `CORPUS_REPO` / `CORPUS_REF` come `corpus-ahead-check.mjs`.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORPUS_REF,
  CORPUS_REPO,
  MANIFEST_PATH_IN_CORPUS,
  declaredTwinPaths,
  fetchRaw,
  identicalTwinEntries,
  readSiteText,
  relativeImportSpecifiers,
  resolveRelativeImport,
  transportManifestPaths,
  undeclaredRelativeImports,
} from './corpus-ahead-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Separa i pericoli di HEAD fra introdotti dalla PR e gia' presenti sulla base.
 *
 * Un pericolo in cui ne' l'importatore ne' il file importato cambiano non puo'
 * essere nuovo: non si legge nemmeno la base. Per gli altri si rilegge
 * l'importatore alla base e si chiede se un suo import risolveva gia', CON
 * L'ALBERO DELLA BASE, allo stesso file: e' il caso di una PR che ritocca un
 * gemello senza toccarne l'import scoperto.
 *
 * @param {object} args
 * @param {Array<{from: string, mode?: string, spec: string, target: string}>} args.hazards
 *   pericoli calcolati su HEAD da `undeclaredRelativeImports`.
 * @param {Set<string>} args.changed path cambiati fra base e HEAD.
 * @param {(rel: string) => string|null} args.readBase sorgente alla base, null se assente.
 * @returns {{introduced: Array<object>, preexisting: Array<object>}}
 */
export function splitIntroducedHazards({ hazards, changed, readBase }) {
  const introduced = [];
  const preexisting = [];
  const existsAtBase = (rel) => readBase(rel) !== null;
  for (const h of hazards) {
    if (!changed.has(h.from) && !changed.has(h.target)) {
      preexisting.push(h);
      continue;
    }
    const baseSource = readBase(h.from);
    const atBase =
      baseSource !== null &&
      relativeImportSpecifiers(baseSource).some(
        (spec) => resolveRelativeImport(h.from, spec, existsAtBase) === h.target,
      );
    (atBase ? preexisting : introduced).push(h);
  }
  return { introduced, preexisting };
}

/** Il rimedio, uguale per ogni pericolo introdotto: detto una volta sola. */
export const REMEDY = [
  'Rimedio, prima del merge: registra il file importato nel manifest del corpus',
  '(`scripts/ci/loop-sync-manifest.json` in nanakokyobashi-rgb/frontaliere-articles, `mode: identical`)',
  'e crealo nel corpus con gli stessi byte, come nella PR corpus #1892; poi rilancia questo job.',
  'Se il modulo entra nel grafo di un bootstrap trusted del corpus (es. `scripts/ci/review-gate-bootstrap-manifest.json`),',
  "quella voce va nello stesso merge dell'importatore. In alternativa evita l'import nel gemello `identical`.",
].join('\n');

function gitLines(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function changedPaths(base) {
  const out = gitLines(['diff', '--name-only', '--no-renames', '-z', base, 'HEAD']);
  return new Set(out.split('\0').filter(Boolean));
}

function baseReader(base) {
  const cache = new Map();
  return (rel) => {
    if (!cache.has(rel)) {
      let text = null;
      try {
        text = gitLines(['show', `${base}:${rel}`]);
      } catch {
        text = null; // assente alla base
      }
      cache.set(rel, text);
    }
    return cache.get(rel);
  };
}

async function loadManifest(manifestFile) {
  if (manifestFile) return JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const buf = await fetchRaw(CORPUS_REPO, CORPUS_REF, MANIFEST_PATH_IN_CORPUS);
  if (!buf) throw new Error(`manifest non trovato: ${CORPUS_REPO}@${CORPUS_REF}/${MANIFEST_PATH_IN_CORPUS}`);
  return JSON.parse(buf.toString('utf8'));
}

function describe(h) {
  return `\`${h.from}\` e' \`identical\` e importa \`${h.spec}\` (${h.target}), che il manifest di sync del corpus non dichiara`;
}

export async function main(argv = process.argv.slice(2)) {
  const valueOf = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const base = valueOf('--base') || 'HEAD^1';

  let manifest;
  try {
    manifest = await loadManifest(valueOf('--manifest'));
    if (!Array.isArray(manifest.files)) throw new Error('manifest senza array `files`');
  } catch (e) {
    console.log(`::warning::identical-twin-import-gate: manifest del corpus illeggibile (${e instanceof Error ? e.message : e}); controllo saltato, resta corpus-ahead-check.yml.`);
    return 0;
  }

  let changed;
  try {
    changed = changedPaths(base);
  } catch {
    console.log(`::warning::identical-twin-import-gate: base \`${base}\` non risolvibile; controllo saltato.`);
    return 0;
  }

  const entries = identicalTwinEntries(manifest);
  const declared = declaredTwinPaths(manifest, transportManifestPaths());
  const hazards = undeclaredRelativeImports({ entries, read: readSiteText, isDeclared: (rel) => declared.has(rel) });
  const { introduced, preexisting } = splitIntroducedHazards({ hazards, changed, readBase: baseReader(base) });

  for (const h of preexisting) {
    console.log(`::warning file=${h.from}::${describe(h)}. Gia' presente su \`${base}\`, non introdotto da questa PR.`);
  }
  for (const h of introduced) {
    console.log(`::error file=${h.from}::${describe(h)}. Il trasporto porterebbe l'importatore senza il modulo: ERR_MODULE_NOT_FOUND nel corpus (corpus #1890).`);
  }
  console.log(
    `identical-twin-import-gate: ${entries.length} gemelli identical, ${hazards.length} import non dichiarati ` +
      `(${introduced.length} introdotti da questa PR, ${preexisting.length} gia' presenti) — base ${base}, ` +
      `manifest ${valueOf('--manifest') || `${CORPUS_REPO}@${CORPUS_REF}`}.`,
  );
  if (introduced.length) {
    console.log(REMEDY);
    return 1;
  }
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`identical-twin-import-gate fallito: ${e && e.stack ? e.stack : e}`);
      process.exit(1);
    },
  );
}
