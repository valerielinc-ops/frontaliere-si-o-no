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
 */

export const GRAPHQL_FILES_CAP = 100;

/**
 * @param {number} number - numero PR
 * @param {number} expected - `changedFiles` dichiarato da GitHub (0/assente = sconosciuto)
 * @param {(args: string[], opts?: {json?: boolean, allowFail?: boolean}) => any} ghFn
 * @param {string} repo - `owner/repo`
 * @returns {{files: string[], complete: boolean}}
 */
export function fetchPrFiles(number, expected, ghFn, repo) {
  let files = [];
  try {
    files = ghFn(['pr', 'view', String(number), '--repo', repo, '--json', 'files',
      '--jq', '[.files // [] | .[].path]'], { allowFail: true }) || [];
  } catch { files = []; }

  const known = Number.isFinite(expected) && expected > 0;
  const cappedExactly = files.length === GRAPHQL_FILES_CAP;
  const suspect = !files.length || files.length >= GRAPHQL_FILES_CAP
    || (known && files.length < expected);
  // `restConfirmed` distingue «la REST ha risposto» da «la REST non c'e'
  // arrivata». Senza, un elenco troncato passa per completo ogni volta che
  // l'oracolo e' piu' basso del cap: vedi il calcolo di `complete` sotto.
  let restConfirmed = false;
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
      // Conferma vuol dire CONSEGNA, non «non ha lanciato». Una REST che esce 0
      // a mani vuote, o che rende meno file della GraphQL, non scioglie
      // l'ambiguita' del cap: la lista puo' essere ancora quella troncata.
      // (Sta prima della riassegnazione per leggibilita', non per necessita':
      // `files = rest` avviene solo quando `rest` e' piu' lunga, e in quel ramo
      // i due ordini danno lo stesso `true`. Misurato: invertirli non rompe
      // nessun test, ed e' corretto cosi' — e' un mutante equivalente.)
      restConfirmed = rest.length >= files.length;
      if (rest.length > files.length) files = rest;
    } catch { /* tiene la lista GraphQL, gia' valutata da `complete` */ }
  }

  // `complete` e' una MISURA, non un default ottimista: se l'oracolo non c'e'
  // (campo assente, fetch fallito) e qualche file c'e', resta false.
  let complete = known ? files.length >= expected : files.length === 0;
  // Esattamente al cap e senza conferma dalla REST, «100» e' ambiguo per
  // costruzione: puo' essere una PR da 100 file o il troncamento di una da
  // 250. `expected` non scioglie il dubbio quando e' piu' basso del cap —
  // succede se la PR cresce fra la `gh pr list` e questa fetch — e in quel
  // caso `files.length >= expected` direbbe «completo» su una lista tagliata.
  // Unknown non e' completo: e' il verso che tutto questo modulo difende.
  if (cappedExactly && !restConfirmed) complete = false;
  return { files, complete };
}
