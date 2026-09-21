// Stato PR di un branch, quando la finestra recency-sorted non basta.
//
// `gh pr list --state all --limit N` è recency-sorted: su un repo ad alto
// volume la finestra copre pochi giorni. Misurato il 2026-09-04 su
// frontaliere-si-o-no: 400 PR = NOVE GIORNI (la più vecchia in finestra era
// #6571 del 26-08, la più recente #7332).
//
// Cadere in "nessuna PR" quando la finestra sfora NON è conservativo: si
// combina con lo squash-merge, dopo il quale i commit del branch non sono mai
// antenati di main e quindi `ahead > 0` resta vero per sempre. Le due
// condizioni insieme rendevano immortale ogni branch di una PR più vecchia
// della finestra — 21 worktree e 14 GB accumulati in questo clone, con #6022,
// #6299, #6313 e #6855 tutte mergiate e invisibili allo script.
//
// La query mirata `--head <branch>` non ha finestra: costa una chiamata per i
// soli branch che la finestra non ha risolto.

// Un nome di branch finisce dentro una stringa di shell, e `git
// check-ref-format` non vieta gli apici: un nome che non so citare non viene
// interrogato e resta report-only, mai cancellato al buio.
export const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

const RANK = { OPEN: 3, MERGED: 2, CLOSED: 1 };

export function rankPrState(state) {
  return RANK[state] ?? 0;
}

// OPEN batte MERGED batte CLOSED: un branch con anche una sola PR aperta è
// lavoro vivo e va protetto, indipendentemente da quante ne ha chiuse.
export function pickBestPrState(prs) {
  let best;
  for (const pr of prs || []) {
    if (!best || rankPrState(pr?.state) > rankPrState(best)) best = pr?.state;
  }
  return best;
}

// `gh pr list` espone gia' MERGED, mentre l'endpoint REST
// `commits/<sha>/pulls` espone una PR mergiata come state=CLOSED con
// merged_at valorizzato. Normalizziamo qui i due contratti, prima di
// scegliere lo stato piu' vivo.
export function normalizeAssociatedPr(pr) {
  if (!pr || typeof pr !== 'object') return undefined;
  const state = pr.merged_at || pr.mergedAt
    ? 'MERGED'
    : String(pr.state || '').toUpperCase();
  if (!RANK[state]) return undefined;
  return { ...pr, state };
}

// Ritorna il record completo, non solo lo stato: il chiamante puo' spiegare
// quale PR ha sbloccato un branch storico e lasciare una traccia nel dry-run.
export function pickBestAssociatedPr(prs, { baseBranch } = {}) {
  let best;
  for (const raw of prs || []) {
    const pr = normalizeAssociatedPr(raw);
    if (baseBranch && pr && (pr.baseRefName || pr.base?.ref) !== baseBranch) continue;
    if (!pr || !best || rankPrState(pr.state) > rankPrState(best.state)) best = pr;
  }
  return best;
}

// L'endpoint per commit non garantisce che la PR punti al default branch del
// repository che stiamo ripulendo. Il base ref e' quindi parte della prova:
// una PR mergiata verso un branch di staging non autorizza a cancellare lo
// snapshot locale del sito.
export function isMergedPullRequestToBase(pr, { baseBranch }) {
  const normalized = normalizeAssociatedPr(pr);
  return normalized?.state === 'MERGED'
    && (normalized.baseRefName || normalized.base?.ref) === baseBranch;
}

export function headQueryCommand(branch) {
  return `gh pr list --head '${branch}' --state all --limit 10 --json state,baseRefName,headRefName,headRefOid`;
}

// Lo stato MERGED da solo non prova che il contenuto del checkout sia arrivato
// su main: la PR potrebbe essere stata aperta verso un altro ramo oppure il
// branch locale potrebbe avere ricevuto commit dopo il merge. Il cleanup può
// rimuovere solo il commit esatto che GitHub ha dichiarato mergiato in main.
export function isMergedIntoBaseAtHead(pr, { baseBranch, headOid }) {
  return pr?.state === 'MERGED'
    && pr?.baseRefName === baseBranch
    && typeof headOid === 'string'
    && headOid.length > 0
    && pr?.headRefOid === headOid;
}

// `cache` è la mappa branch → stato già popolata dalla finestra. Il miss viene
// memorizzato come qualunque altro esito: un branch senza PR non deve essere
// interrogato due volte (i loop worktree e branch lo incontrano entrambi).
// `viaHead` raccoglie i branch il cui stato viene DALLA QUERY MIRATA e non
// dalla finestra. Serve al chiamante per non allargare il raggio del delete: un
// `CLOSED` risolto qui puo' venire da qualunque punto della storia del repo, e
// `CLOSED` non e' `MERGED` — il contenuto NON e' su main, quindi i commit unici
// del branch sono l'unica copia rimasta. E' la classe di incidente che il
// gemello remoto protegge esplicitamente (label `autorebase-reopen-failed`,
// #5269 chiusa da un guasto e non da una decisione, branch cancellato e con
// esso #5275). Lato locale quella protezione non c'e': finora era la finestra
// di nove giorni a limitare il danno per caso, non per progetto.
export function makePrStateResolver({ cache, runQuery, enabled = true, viaHead = new Set() }) {
  return function resolvePrState(branch) {
    if (!branch) return undefined;
    if (cache.has(branch)) return cache.get(branch);
    if (!enabled || !SAFE_BRANCH_RE.test(branch)) return undefined;
    const raw = runQuery(headQueryCommand(branch));
    let best;
    if (raw) {
      try { best = pickBestPrState(JSON.parse(raw)); } catch { /* non-JSON = nessuna PR trovata */ }
    }
    cache.set(branch, best);
    if (best) viaHead.add(branch);
    return best;
  };
}
