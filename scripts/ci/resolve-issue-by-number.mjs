#!/usr/bin/env node
/**
 * resolve-issue-by-number.mjs — CLI di `resolveGithubIssueByNumber` per i
 * workflow che hanno GIA' deciso su un numero preciso.
 *
 * `github-issue-creator.mjs --resolve` riceve solo `--title` e chiude la piu'
 * recente fra le aperte il cui titolo COMINCIA col prefisso sanitizzato a 60
 * caratteri: un titolo di dedup piu' corto (il digest needs-human ne ha 52)
 * coincide col proprio prefisso, quindi una issue aperta che comincia con la
 * stessa chiave e prosegue verrebbe chiusa al posto sua. Un workflow che ha
 * risolto il numero con l'uguaglianza ESATTA del titolo chiude quel numero da
 * qui: lo stato e il titolo vengono riletti subito prima della scrittura, e la
 * chiusura e' verificata (stesso contratto della libreria).
 *
 *   node scripts/ci/resolve-issue-by-number.mjs \
 *     --number 6458 \
 *     --expected-title "needs-human: PR bloccate in attesa di revisione umana" \
 *     [--workflow "Recycle stale PRs"] [--run-url URL] [--preface "perche'"]
 *
 * Exit 0: chiusa e verificata, oppure niente da fare (gia' chiusa, titolo
 * cambiato dopo la decisione, reporting disattivato). Exit 1: argomenti
 * inutilizzabili, issue illeggibile, chiusura rifiutata o non verificata —
 * una chiusura mancata non deve sembrare un no-op riuscito.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolveGithubIssueByNumber } from '../lib/github-issue-creator.mjs';

export function parseArgs(argv) {
  const get = (flag) => {
    const idx = argv.indexOf(flag);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  return {
    number: get('--number'),
    expectedTitle: get('--expected-title'),
    workflow: get('--workflow'),
    runUrl: get('--run-url'),
    preface: get('--preface'),
  };
}

/** Exit code for the CLI, given the arguments and an injectable resolver. */
export function runResolveByNumber(argv, resolve = resolveGithubIssueByNumber) {
  const { number, expectedTitle, workflow, runUrl, preface } = parseArgs(argv);
  if (!/^[1-9][0-9]*$/.test(String(number ?? '')) || !expectedTitle) {
    console.error('[resolve-issue-by-number] uso: --number <N> --expected-title "<titolo esatto>" [--workflow W] [--run-url U] [--preface P]');
    return 1;
  }
  let result;
  try {
    result = resolve(Number(number), { expectedTitle, workflow, runUrl, preface });
  } catch (err) {
    console.error(`[resolve-issue-by-number] ${err?.message || err}`);
    return 1;
  }
  if (result === null) return 0; // ENABLE_FAILURE_REPORT=false: deliberato, gia' loggato
  if (result?.persisted === true) return 0;
  if (result?.skipped === 'not-open' || result?.skipped === 'title-changed') return 0;
  console.error(`[resolve-issue-by-number] #${number} non chiusa (${result?.skipped || 'esito sconosciuto'})`);
  return 1;
}

const isDirectRun = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
})();
if (isDirectRun) {
  process.exit(runResolveByNumber(process.argv.slice(2)));
}
