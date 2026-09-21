// Guardie pure del purge. Tenerle senza git/gh rende verificabile la parte
// rischiosa della decisione: uno stato chiuso non prova che il contenuto sia
// confluito; zero commit ahead e' l'unica prova locale disponibile in quel
// caso. Una PR MERGED e' invece una prova esplicita sufficiente, anche con
// squash-merge (dove ahead resta > 0 per costruzione).

export function canDeleteClosedCandidate({ ahead }) {
  return ahead === 0;
}

export function canDeleteIssueFix({ issueState, issueReason, ahead }) {
  return issueState === 'closed'
    && issueReason !== 'not_planned'
    && canDeleteClosedCandidate({ ahead });
}

export function needsSnapshot({ prState, ahead, hasSnapshot }) {
  return prState === 'MERGED' && ahead !== 0 && !hasSnapshot;
}

// `git rev-list` nel clone locale non basta per i PR squashati: il commit
// della PR puo' non essere presente nel clone, mentre GitHub puo' confrontarlo
// con l'HEAD remoto. La prova ammessa e' quindi il risultato di
// `compare/<local-tip>...<pr-head>` con zero commit dietro: il tip locale e'
// contenuto nella storia della PR mergiata (o coincide con il suo HEAD).
export function hasAncestryProof(compare) {
  return Number.isInteger(compare?.behind_by) && compare.behind_by === 0;
}
