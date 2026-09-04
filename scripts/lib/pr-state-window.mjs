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

export function headQueryCommand(branch) {
  return `gh pr list --head '${branch}' --state all --limit 10 --json state`;
}

// `cache` è la mappa branch → stato già popolata dalla finestra. Il miss viene
// memorizzato come qualunque altro esito: un branch senza PR non deve essere
// interrogato due volte (i loop worktree e branch lo incontrano entrambi).
export function makePrStateResolver({ cache, runQuery, enabled = true }) {
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
    return best;
  };
}
