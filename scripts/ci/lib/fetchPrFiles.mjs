/**
 * fetchPrFiles.mjs — fallback GraphQL→REST per l'elenco file di una PR, con
 * `restConfirmed`/cap-100, condiviso da `pr-collision-detector.mjs` e dal CLI
 * `fetch-pr-files.mjs` (usato a sua volta da `pr-redflag-fixer.yml` e
 * `pr-review-loop.yml`, issue #6233).
 *
 * Prima erano TRE copie indipendenti della stessa logica (questa, più due
 * reimplementazioni inline in bash nei due workflow) tenute allineate a mano
 * — esattamente la forma che `check-sibling-patterns.mjs --strict` è fatto
 * per pescare (vedi PR #6224). Estratta qui una volta sola: i workflow ora
 * invocano il CLI invece di reimplementare l'algoritmo in shell.
 *
 * `gh pr view --json files` chiede la connection GraphQL `files(first: 100)`
 * e NON pagina:
 *
 *   <= 100     lista completa
 *   101..N     TRONCATA a 100, in ordine alfabetico, exit 0, lista NON vuota
 *   oversize   `.files: null` (GitHub rinuncia a calcolare il diff)
 *
 * `restConfirmed` distingue «la REST ha risposto» da «la REST non c'è
 * arrivata»: senza, un elenco troncato passa per completo ogni volta che
 * l'oracolo (`changedFiles`) è più basso del cap. Misurato il 2026-08-20:
 * #6121 changedFiles=183 → GraphQL 100, REST `--paginate` 183/183; #6175 →
 * GraphQL null, REST 100 (troncata).
 *
 * `changedFiles` (l'oracolo) e `files` (la lista GraphQL) vengono fetchati in
 * UNA SOLA `gh pr view --json changedFiles,files`, non due chiamate separate
 * (#6206 item 3). Prima, il CLI `fetch-pr-files.mjs` prendeva `expected` da un
 * `gh pr view --json changedFiles` indipendente e poi chiamava questa funzione
 * con quel valore; `pr-collision-detector.mjs` lo prendeva da un `gh pr list`
 * fatto una volta sola PRIMA del loop su tutte le PR aperte, quindi sempre più
 * stale man mano che il loop avanzava. Un push sulla PR tra le due letture fa
 * leggere un `expected` vecchio contro un `files` nuovo (o viceversa),
 * producendo un falso `complete=true` — la stessa classe di race già chiusa in
 * pr-review-loop.yml/pr-redflag-fixer.yml (che leggono entrambi i campi da
 * un'unica `gh pr view` inline). Qui i due valori vengono dalla stessa
 * risposta GraphQL: nessuna finestra di push fra di loro.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const GRAPHQL_FILES_CAP = 100;

/**
 * Tetto rigido della REST `pulls/{n}/files`: `--paginate` non va oltre, per
 * quanto grande sia la PR. Sopra questa soglia nessun secondo livello di
 * fallback esiste — l'elenco resta troncato per limite dell'API, non per un
 * difetto nostro (follow-up #6206 item 1). Serve a ETICHETTARE quel caso:
 * `complete:false` con `reason:'rest-hard-limit'` e' irrisolvibile da qui,
 * mentre gli altri `complete:false` sono condizioni transitorie.
 */
export const REST_FILES_HARD_CAP = 3000;

/**
 * Tetto del fallback per-commit: `pulls/{n}/commits` non rende piu' di 250
 * commit, e ogni commit costa una chiamata. Sopra questa soglia l'elenco
 * resta sconosciuto (fail-closed), non campionato.
 */
export const COMMIT_FALLBACK_MAX_COMMITS = 100;

const nonEmptyLines = (raw) => String(raw || '').split('\n').map((line) => line.trim()).filter(Boolean);

/**
 * Terza sorgente, che non genera il diff della PR: l'unione dei file toccati da
 * ciascun commit (`pulls/{n}/commits` + `commits/{sha}`). La REST
 * `pulls/{n}/files` e `gh pr view --json files` calcolano il diff complessivo
 * e per i diff grandi rispondono `HTTP 422 Sorry, this diff is taking too long
 * to generate` (PR #18860, run 43699831609): lo stesso errore che prima lasciava
 * l'elenco VUOTO e «completo» e negava l'auto-merge con `paths-unverifiable`.
 *
 * L'unione e' un SOPRAINSIEME del diff netto: ogni file cambiato dalla PR e'
 * toccato da almeno un commit (un file toccato e poi ripristinato compare in
 * piu'), quindi e' sicura per un gate che classifica i path. Qualunque
 * impossibilita' di provarla intera — commit non elencabili, piu' di
 * COMMIT_FALLBACK_MAX_COMMITS commit, un commit senza file (vuoto o con diff
 * omesso: indistinguibili), un commit al tetto REST dei file, un errore su una
 * chiamata, un'unione vuota — rende `null`: sconosciuto, mai parziale.
 *
 * @returns {string[]|null}
 */
function filesFromPullCommits(number, ghFn, repo) {
  try {
    const shas = nonEmptyLines(ghFn(['api', `repos/${repo}/pulls/${number}/commits?per_page=100`,
      '--paginate', '--jq', '.[].sha'], { json: false }));
    if (shas.length === 0 || shas.length > COMMIT_FALLBACK_MAX_COMMITS) return null;
    const union = new Set();
    for (const sha of shas) {
      if (!/^[0-9a-f]{40}$/iu.test(sha)) return null;
      const files = nonEmptyLines(ghFn(['api', `repos/${repo}/commits/${sha}?per_page=100`,
        '--paginate', '--jq', '(.files // [])[].filename'], { json: false }));
      // Un commit con ZERO file e' ambiguo per costruzione: puo' essere davvero
      // vuoto o avere il diff omesso da GitHub perche' troppo grande
      // (`files: []`, `stats.total: 0`, misurato su #18860). Non sono
      // distinguibili: l'unione sarebbe un sottoinsieme che la policy
      // classificherebbe come completo (fail-open su una PR a piu' commit).
      if (files.length === 0 || files.length >= REST_FILES_HARD_CAP) return null;
      for (const file of files) union.add(file);
    }
    return union.size > 0 ? [...union] : null;
  } catch (error) {
    if (isTypedTransientReadError(error)) throw error;
    return null;
  }
}

/**
 * Fatti della REST `pulls/{n}`: `changed_files` (un contatore, non un diff,
 * quindi risponde anche quando GraphQL rende `changedFiles: 0` / `files: null`
 * su un diff grande: misurato su #18860, GraphQL 0 e REST 17) e `head.sha`
 * (la HEAD valutata, che il fallback git confronta con il merge ref).
 *
 * @returns {{changed?: number, head?: string}}
 */
function restPullFacts(number, ghFn, repo) {
  try {
    const raw = ghFn(['api', `repos/${repo}/pulls/${number}`, '--jq', '"\\(.changed_files) \\(.head.sha)"'], { json: false });
    const [changedRaw, headRaw] = String(raw || '').trim().split(/\s+/u);
    const changed = Number(changedRaw);
    return {
      ...(Number.isSafeInteger(changed) && changed > 0 ? { changed } : {}),
      ...(/^[0-9a-f]{40}$/iu.test(headRaw || '') ? { head: headRaw.toLowerCase() } : {}),
    };
  } catch (error) {
    if (isTypedTransientReadError(error)) throw error;
    return {};
  }
}

/**
 * Ultima fonte, per un chiamante che puo' eseguire `git`: il merge ref della
 * PR (`refs/pull/<n>/merge`), come faceva il vecchio detect del replay. Il
 * diff NETTO fra il primo genitore e il merge e' esatto e non dipende ne' dai
 * limiti di GitHub sul diff ne' dal numero di commit.
 *
 * Il fetch avviene in un repository bare temporaneo (depth 2, blob-less: solo
 * commit e tree): non tocca il checkout del chiamante e non lo rende shallow.
 * Il token passa per `GIT_CONFIG_*` dell'ambiente del figlio, mai negli
 * argomenti. Fail-closed: il merge ref deve avere ESATTAMENTE due genitori e il
 * secondo deve essere la HEAD valutata; un merge ref stantio (la PR ha avuto un
 * push, o la base si e' mossa) o un errore qualunque rendono `null`.
 *
 * @param {{ token?: string, git?: (args: string[], options: {cwd: string, env: object}) => string }} [options]
 * @returns {(request: {number: number, repo: string, headSha: string}) => string[]|null}
 */
export function createGitMergeRefReader({
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '',
  git = (args, options) => execFileSync('git', args, {
    ...options, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }),
} = {}) {
  return ({ number, repo, headSha }) => {
    if (!Number.isSafeInteger(number) || number <= 0
      || !/^[\w.-]+\/[\w.-]+$/u.test(String(repo || ''))
      || !/^[0-9a-f]{40}$/iu.test(String(headSha || ''))) return null;
    const dir = mkdtempSync(join(tmpdir(), 'pr-files-'));
    try {
      const env = {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        ...(token
          ? {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
            GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
          }
          : {}),
      };
      const run = (args) => git(args, { cwd: dir, env });
      run(['init', '--bare', '--quiet']);
      run(['remote', 'add', 'origin', `https://github.com/${repo}.git`]);
      const ref = `refs/remotes/pr-files/${number}`;
      run(['fetch', '--no-tags', '--depth=2', '--filter=blob:none', 'origin', `+refs/pull/${number}/merge:${ref}`]);
      const words = String(run(['rev-list', '--parents', '-n', '1', ref])).trim().split(/\s+/u);
      if (words.length !== 3) return null; // merge + 2 genitori
      const [merge, base, head] = words;
      if (head.toLowerCase() !== String(headSha).toLowerCase()) return null; // merge ref stantio
      const out = String(run(['diff', '--name-only', '--no-renames', '-z', base, merge]));
      return out.split('\0').filter(Boolean);
    } catch {
      return null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const TRANSIENT_PR_FILE_SNAPSHOT_REASONS = new Set([
  'list-fetch-failed',
  'graphql-cap',
  'short-of-oracle',
]);

// Review-gate API reads carry a typed transport verdict.  It must cross this
// helper instead of being collapsed into `complete:false`, otherwise a GitHub
// rate-limit becomes a normal in-diff review failure and the exact HEAD/body
// evidence is lost.  Ordinary callers still keep the historical fail-closed
// snapshot behavior.
function isTypedTransientReadError(error) {
  return error?.code === 'REVIEW_GATE_TRANSIENT'
    || error?.failureKind === 'transient';
}

/**
 * @param {number} number - numero PR
 * @param {(args: string[], opts?: {json?: boolean, allowFail?: boolean}) => any} ghFn
 * @param {string} repo - `owner/repo`
 * @param {{ gitFn?: (request: {number: number, repo: string, headSha: string}) => string[]|null }} [options]
 *   `gitFn`: ultima fonte opzionale (vedi `createGitMergeRefReader`); senza, il
 *   comportamento resta quello delle sole API.
 * @returns {{files: string[], complete: boolean, expected: number|undefined, reason: string}}
 */
export function fetchPrFiles(number, ghFn, repo, { gitFn } = {}) {
  let files = [];
  let expected;
  // «La chiamata ha risposto» non e' «la risposta e' vuota».
  //
  // `gh(..., {allowFail:true})` rende `null` quando il comando fallisce e un
  // OGGETTO `{changedFiles, files}` quando riesce — anche con `files: []`.
  // Collassare i due rendeva una PR rebase-only indistinguibile da una `gh`
  // muta: con l'oracolo pure fallito (`expected` assente), `complete` cadeva
  // sul ramo `files.length === 0` e usciva TRUE. Era il falso «completo» che
  // questo modulo esiste per impedire — e a valle sceglieva il tier `normal`
  // saltando proprio il guard sull'incompletezza (follow-up #6206 item 3).
  let listOk = false;
  try {
    const raw = ghFn(['pr', 'view', String(number), '--repo', repo, '--json', 'changedFiles,files',
      '--jq', '{changedFiles: (.changedFiles // 0), files: [.files // [] | .[].path]}'], { allowFail: true });
    if (raw && Array.isArray(raw.files)) { files = raw.files; listOk = true; expected = raw.changedFiles; }
  } catch (error) {
    if (isTypedTransientReadError(error)) throw error;
    files = [];
  }

  let known = Number.isFinite(expected) && expected > 0;
  const cappedExactly = files.length === GRAPHQL_FILES_CAP;
  const suspect = !files.length || files.length >= GRAPHQL_FILES_CAP
    || (known && files.length < expected);
  // `restConfirmed` distingue «la REST ha risposto» da «la REST non c'e'
  // arrivata». Senza, un elenco troncato passa per completo ogni volta che
  // l'oracolo e' piu' basso del cap: vedi il calcolo di `complete` sotto.
  let restConfirmed = false;
  // `restAnswered`: la REST `pulls/{n}/files` ha RISPOSTO (anche a vuoto). Se ha
  // lanciato (422 «diff is taking too long», rate limit, rete) la vista
  // combinata che rendeva `{changedFiles: 0, files: []}` non e' un «nessun
  // file»: e' l'assenza di un elenco. Con la REST muta quel vuoto usciva
  // `complete: true` e il gate nativo negava `paths-unverifiable` (#18860).
  let restAnswered = false;
  let fromCommits = false;
  let fromGit = false;
  let oracleFromRest = false;
  if (suspect) {
    try {
      // `--paginate` applica il `--jq` a OGNI pagina: un filtro che produce un
      // array darebbe piu' valori JSON top-level concatenati, che JSON.parse
      // rifiuta. Quindi filtro a righe e split, che regge n pagine.
      // `allowFail` NON va usato qui: il `gh()` reale lo traduce in `''`, e un
      // fallimento silenzioso e' un segnale in meno. Senza, arriva come
      // eccezione e il catch qui sotto lo assorbe. Non e' pero' cio' da cui
      // dipende l'invariante: `restConfirmed` misura quanti file la REST ha
      // CONSEGNATO, quindi un `''` da `allowFail` conta come non-conferma
      // esattamente come un throw. La chiamata resta senza `allowFail` perche'
      // un errore esplicito e' meglio di uno muto, non perche' il guard ci si
      // appoggi.
      const raw = ghFn(['api', `repos/${repo}/pulls/${number}/files`, '--paginate',
        '--jq', '.[].filename'], { json: false }) || '';
      const rest = raw.split('\n').map((l) => l.trim()).filter(Boolean);
      restAnswered = true;
      // Conferma vuol dire CONSEGNA, non «non ha lanciato». Una REST che esce 0
      // a mani vuote, o che rende meno file della GraphQL, non scioglie
      // l'ambiguita' del cap: la lista puo' essere ancora quella troncata.
      // (Sta prima della riassegnazione per leggibilita', non per necessita':
      // `files = rest` avviene solo quando `rest` e' piu' lunga, e in quel ramo
      // i due ordini danno lo stesso `true`. Misurato: invertirli non rompe
      // nessun test, ed e' corretto cosi' — e' un mutante equivalente.)
      restConfirmed = rest.length >= files.length;
      if (rest.length > files.length) files = rest;
    } catch (error) {
      if (isTypedTransientReadError(error)) throw error;
      // Tiene la lista GraphQL, già valutata da `complete`.
    }
    let facts = null;
    const pullFacts = () => {
      if (facts === null) facts = restPullFacts(number, ghFn, repo);
      return facts;
    };
    const adoptRestOracle = () => {
      const { changed } = pullFacts();
      if (changed !== undefined) {
        expected = changed;
        known = true;
        oracleFromRest = true;
      }
    };
    if (!restAnswered) {
      // Terza sorgente senza diff: i file per commit. Solo se la REST non ha
      // risposto: con una risposta (anche troncata) vale la logica sopra.
      const perCommit = filesFromPullCommits(number, ghFn, repo);
      if (perCommit !== null && perCommit.length >= files.length) {
        files = perCommit;
        fromCommits = true;
      }
    }
    if (fromCommits) {
      // L'unione per commit e' un soprainsieme solo SE nessun commit ha il diff
      // omesso: l'oracolo REST `changed_files` lo verifica sempre, e senza
      // oracolo noto l'unione non e' provata (vedi `complete` sotto).
      adoptRestOracle();
    } else if (!known && files.length > 0) {
      // Oracolo GraphQL sconosciuto (oversize: `changedFiles: 0`) ma una lista
      // consegnata: il contatore REST `changed_files` scioglie il dubbio.
      adoptRestOracle();
    }
    // Ultima fonte: il merge ref, solo se le API non hanno dato un elenco
    // (nessuna risposta, nessun commit utilizzabile) o l'unione per commit e'
    // piu' corta dell'oracolo (un commit grande ha perso i suoi file).
    const noList = files.length === 0 && !restAnswered;
    const unionShort = fromCommits && !(known && files.length >= expected);
    if (typeof gitFn === 'function' && (noList || unionShort)) {
      const { head } = pullFacts();
      let gitFiles = null;
      if (head) {
        try {
          gitFiles = gitFn({ number, repo, headSha: head });
        } catch (error) {
          if (isTypedTransientReadError(error)) throw error;
          gitFiles = null;
        }
      }
      if (Array.isArray(gitFiles)) {
        files = gitFiles;
        fromGit = true;
        fromCommits = false;
        adoptRestOracle();
      }
    }
  }

  // `complete` e' una MISURA, non un default ottimista: se l'oracolo non c'e'
  // (campo assente, fetch fallito) e qualche file c'e', resta false.
  // `listOk` e' la precondizione: un elenco che nessuno ha mai consegnato non
  // e' «vuoto», e' sconosciuto — e sconosciuto non e' completo.
  // Una lista consegnata dalla REST e misurata dal suo contatore e' affidabile
  // anche se la vista GraphQL non ha risposto.
  let complete = (listOk || oracleFromRest) && (known ? files.length >= expected : files.length === 0);
  if (fromGit) {
    // Diff netto del merge ref (HEAD verificata): esatto; falso solo se
    // l'oracolo REST dice che mancano file (con --no-renames un rinominato conta
    // due volte, quindi `>=`).
    complete = !(known && files.length < expected);
  } else if (fromCommits) {
    // Il soprainsieme per commit e' provato solo dall'oracolo REST: oracolo
    // assente o unione piu' corta (un commit con diff omesso) = incompleto.
    complete = known && files.length >= expected;
  } else if (suspect && files.length === 0 && !restAnswered) {
    // Vista combinata vuota + REST muta + nessun fallback: elenco mancante.
    complete = false;
  }
  // Esattamente al cap e senza conferma dalla REST, «100» e' ambiguo per
  // costruzione: puo' essere una PR da 100 file o il troncamento di una da
  // 250. `expected` non scioglie il dubbio quando e' piu' basso del cap —
  // succede se la PR cresce fra la `gh pr list` e questa fetch — e in quel
  // caso `files.length >= expected` direbbe «completo» su una lista tagliata.
  // Unknown non e' completo: e' il verso che tutto questo modulo difende.
  if (cappedExactly && !restConfirmed && !fromCommits && !fromGit) complete = false;
  if (files.length >= REST_FILES_HARD_CAP && !fromGit) complete = false;
  const listMissing = suspect && files.length === 0 && !restAnswered && !fromCommits && !fromGit;
  return {
    files,
    complete,
    expected,
    reason: incompletenessReason({ complete, listOk: listOk || oracleFromRest, listMissing, files, cappedExactly, restConfirmed }),
  };
}

/**
 * A bounded retry may re-read these incomplete snapshots. The hard REST cap
 * and unknown reasons are not transiently recoverable and must remain
 * fail-closed at every consumer.
 */
export function isRetryablePrFileSnapshot(snapshot) {
  return snapshot?.complete !== true
    && TRANSIENT_PR_FILE_SNAPSHOT_REASONS.has(snapshot?.reason);
}

/**
 * Perche' l'elenco non e' completo — la distinzione che mancava a valle, dove
 * ogni `complete:false` stampava la stessa riga e un limite invalicabile
 * dell'API sembrava un bug ordinario (follow-up #6206 item 1).
 *
 * `rest-hard-limit` e' l'unico irrisolvibile da qui: sopra i 3000 file la REST
 * non ha una pagina successiva da dare. Gli altri due sono transitori — una
 * `gh` muta o una conferma REST mancata rientrano al giro dopo.
 *
 * @returns {'complete'|'list-fetch-failed'|'rest-hard-limit'|'graphql-cap'|'short-of-oracle'}
 */
function incompletenessReason({ complete, listOk, listMissing = false, files, cappedExactly, restConfirmed }) {
  if (complete) return 'complete';
  if (!listOk || listMissing) return 'list-fetch-failed';
  if (files.length >= REST_FILES_HARD_CAP) return 'rest-hard-limit';
  if (cappedExactly && !restConfirmed) return 'graphql-cap';
  return 'short-of-oracle';
}
