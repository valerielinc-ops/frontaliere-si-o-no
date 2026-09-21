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
