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
 *   base, dove «assente» si misura con l'albero E con le dichiarazioni della
 *   base. La PR puo' introdurlo aggiungendo l'import, aggiungendo il file
 *   importato, o togliendo una riga del transport manifest che lo copriva.
 * - La base: `tests.yml` la passa sempre con `--base` (`pull_request.base.sha`
 *   sulle PR, `merge_group.base_sha` nella coda), quindi il diff copre tutti i
 *   commit della PR. Senza `--base` vale `HEAD^1` solo se HEAD e' un merge
 *   commit (la forma di `refs/pull/N/merge`); un HEAD con un solo genitore e'
 *   un errore, non un'ipotesi.
 * - Un pericolo gia' presente sulla base resta un `::warning::`. Bloccarlo
 *   renderebbe rossa ogni PR che tocca quel gemello per un difetto che non ha
 *   introdotto; peggio, una voce tolta dal manifest del CORPUS renderebbe rosse
 *   tutte le PR del sito senza che nessuna abbia cambiato niente. Quei casi
 *   restano del controllo giornaliero.
 * - Manifest del corpus illeggibile (dopo tre tentativi) o base non
 *   risolvibile: rosso. Un cancello che non ha potuto guardare non e' verde;
 *   se era un'indisponibilita' passeggera basta un rerun.
 *
 * Costo: i gemelli si leggono dal checkout (o da `git show HEAD:` se lo sparse
 * non li ha); la base si legge solo per i pochi pericoli candidati, perche' il
 * checkout di CI e' `filter: tree:0` e ogni oggetto assente e' un fetch.
 *
 * Uso:
 *   node scripts/ci/identical-twin-import-gate.mjs                     # base = HEAD^1 di un merge commit
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
  TRANSPORT_MANIFEST,
  declaredTwinPaths,
  fetchRaw,
  identicalTwinEntries,
  parseTransportManifest,
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
 * Un pericolo esisteva alla base se, CON L'ALBERO E LE DICHIARAZIONI DELLA
 * BASE, l'importatore importava gia' quel file e quel file non era dichiarato.
 * Tre modi di introdurlo, quindi: la PR aggiunge l'import, aggiunge il file
 * importato (prima l'import non risolveva), oppure toglie la dichiarazione (una
 * riga del transport manifest, che vive in questo repo). Se nessuna delle tre
 * cose e' cambiata non si legge nemmeno la base.
 *
 * @param {object} args
 * @param {Array<{from: string, mode?: string, spec: string, target: string}>} args.hazards
 *   pericoli calcolati su HEAD da `undeclaredRelativeImports`.
 * @param {Set<string>} args.changed path cambiati fra base e HEAD.
 * @param {(rel: string) => string|null} args.readBase sorgente alla base, null se assente.
 * @param {(rel: string) => boolean} [args.isDeclaredAtBase] il path era dichiarato alla base?
 * @returns {{introduced: Array<object>, preexisting: Array<object>}}
 */
export function splitIntroducedHazards({ hazards, changed, readBase, isDeclaredAtBase = () => false }) {
  const introduced = [];
  const preexisting = [];
  const existsAtBase = (rel) => readBase(rel) !== null;
  for (const h of hazards) {
    const declaredAtBase = isDeclaredAtBase(h.target);
    if (!declaredAtBase && !changed.has(h.from) && !changed.has(h.target)) {
      preexisting.push(h);
      continue;
    }
    const baseSource = declaredAtBase ? null : readBase(h.from);
    const atBase =
      baseSource !== null &&
      relativeImportSpecifiers(baseSource).some(
        (spec) => resolveRelativeImport(h.from, spec, existsAtBase) === h.target,
      );
    (atBase ? preexisting : introduced).push(h);
  }
  return { introduced, preexisting };
}

/**
 * La consegna del transport alla base. Uguale a quella di HEAD se la PR non
 * tocca ne' il transport manifest ne' un file sotto uno dei suoi glob: e' il
 * caso di quasi ogni PR, e cosi' non costa niente.
 *
 * @param {object} args
 * @param {Set<string>} args.changed
 * @param {string[]} args.headPaths `transportManifestPaths()` su HEAD.
 * @param {(rel: string) => string|null} args.readBase
 * @param {(dir: string) => string[]} args.listBase file tracciati sotto `dir` alla base.
 * @returns {string[]}
 */
export function transportPathsAtBase({ changed, headPaths, readBase, listBase }) {
  const headText = readSiteText(TRANSPORT_MANIFEST);
  const globsOf = (text) => (text === null ? [] : parseTransportManifest(text).globs);
  const touchesGlob = (globs) => [...changed].some((p) => globs.some((g) => p.startsWith(`${g}/`)));
  if (!changed.has(TRANSPORT_MANIFEST) && !touchesGlob(globsOf(headText))) return headPaths;
  const baseText = readBase(TRANSPORT_MANIFEST);
  if (baseText === null) return [];
  const { listed, globs } = parseTransportManifest(baseText);
  const out = new Set(listed);
  for (const g of globs) for (const rel of listBase(g)) out.add(rel);
  return [...out];
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

function listBaseReader(base) {
  return (dir) => gitLines(['ls-tree', '-r', '--name-only', '-z', base, '--', dir]).split('\0').filter(Boolean);
}

/**
 * La base del confronto. Con `--base` e' quella. Senza, HEAD deve essere un
 * merge commit: sul checkout di `tests.yml` (`ref: github.ref`, cioe'
 * `refs/pull/N/merge`) `HEAD^1` e' la punta di main e il diff copre TUTTI i
 * commit della PR. Su un HEAD con un solo genitore `HEAD^1` sarebbe solo il
 * commit precedente della PR: un import introdotto in un commit prima passerebbe
 * per «gia' presente». Meglio rosso che quella risposta.
 */
function resolveBase(explicit) {
  if (explicit) return explicit;
  const parents = gitLines(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/).length - 1;
  if (parents < 2) {
    throw new Error("HEAD non e' un merge commit: senza --base il confronto coprirebbe solo l'ultimo commit della PR");
  }
  return 'HEAD^1';
}

const MANIFEST_FETCH_ATTEMPTS = 3;

async function loadManifest(manifestFile) {
  if (manifestFile) return JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  // Tre tentativi: un blip di raw.githubusercontent.com non deve diventare un
  // rosso; un'indisponibilita' vera si'.
  let lastError;
  for (let attempt = 1; attempt <= MANIFEST_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const buf = await fetchRaw(CORPUS_REPO, CORPUS_REF, MANIFEST_PATH_IN_CORPUS);
      if (!buf) throw new Error(`manifest non trovato: ${CORPUS_REPO}@${CORPUS_REF}/${MANIFEST_PATH_IN_CORPUS}`);
      return JSON.parse(buf.toString('utf8'));
    } catch (e) {
      lastError = e;
      if (attempt < MANIFEST_FETCH_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  throw lastError;
}

function describe(h) {
  return `\`${h.from}\` e' \`identical\` e importa \`${h.spec}\` (${h.target}), che il manifest di sync del corpus non dichiara`;
}

export async function main(argv = process.argv.slice(2)) {
  const valueOf = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  // Fail-closed sui due input: un cancello che non ha potuto guardare non e' un
  // cancello verde. Il rosso dice quale input manca, e un rerun basta se era
  // un'indisponibilita' passeggera.
  let manifest;
  try {
    manifest = await loadManifest(valueOf('--manifest'));
    if (!Array.isArray(manifest.files)) throw new Error('manifest senza array `files`');
  } catch (e) {
    console.log(`::error::identical-twin-import-gate: manifest del corpus illeggibile (${e instanceof Error ? e.message : e}); impossibile verificare gli import dei gemelli identical. Se e' un'indisponibilita' di rete, rilancia il job.`);
    return 1;
  }

  let base;
  let changed;
  try {
    base = resolveBase(valueOf('--base'));
    changed = changedPaths(base);
  } catch (e) {
    console.log(`::error::identical-twin-import-gate: base del confronto non risolvibile (${e instanceof Error ? e.message.split('\n')[0] : e}).`);
    return 1;
  }

  const readBase = baseReader(base);
  const entries = identicalTwinEntries(manifest);
  const headTransport = transportManifestPaths();
  const declared = declaredTwinPaths(manifest, headTransport);
  const declaredAtBase = declaredTwinPaths(
    manifest,
    transportPathsAtBase({ changed, headPaths: headTransport, readBase, listBase: listBaseReader(base) }),
  );
  const hazards = undeclaredRelativeImports({ entries, read: readSiteText, isDeclared: (rel) => declared.has(rel) });
  const { introduced, preexisting } = splitIntroducedHazards({
    hazards,
    changed,
    readBase,
    isDeclaredAtBase: (rel) => declaredAtBase.has(rel),
  });

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
