<!--
  Completeness contract (REVIEW.md / AGENTS.md § Workflow).
  Le DUE sezioni qui sotto sono OBBLIGATORIE — il reviewer e pr-body-contract.yml
  le leggono per il gating. Non rinominarle (no `## Fix`, `## Verify`, `## Effetto`):
  il check cerca i due header letterali `## Implementato` e `## Non implementato`.
  Closes #N / Supersedes #N se la PR rende moot un'issue aperta.
  Per chiudere PIÙ issue: una keyword per issue, una per riga —
    Closes #12
    Closes #34
  MAI `Closes #12 #34 #56` su una riga: GitHub chiude solo #12, il resto resta
  aperto (cfr. PR #1320). pr-body-contract.yml flagga la riga multi-issue.
  MAI `Closes #N` se #N è una follow-up AGGREGATA multi-item: `Closes` scatta al
  merge e chiuderebbe l'aggregata con item ancora dovuti — pr-body-contract.yml
  la flagga e la PR nasce rossa (cfr. #5848, #5862). Scrivi `Addresses #N`
  (l'aggregata la chiude reconcile-followups.mjs quando TUTTI gli item sono fatti).
  Nel dubbio non tirare a indovinare, calcolala:
    gh issue view N --json number,title,body,labels \
      | node scripts/lib/pr-body-generator-contract.mjs --closing-ref
-->

## Implementato

<!-- Cosa fa la PR. Bullet concreti: file/comportamento cambiato. -->
-

## Non implementato (ancora)

<!--
  PIANO DI COMPLETAMENTO del task, NON scope-deferito-e-chiuso (AGENTS.md #8).
  Il task è chiuso SOLO quando questa sezione legge "Nessuno". Ogni voce è lavoro
  ancora DOVUTO: indica lo stato/next-step, non un motivo-scappatoia.
    - <scope> — in questa PR
    - <scope> — PR concatenata #N (in arrivo)
    - <scope> — blocked: <causa esterna reale>
  "out of scope" / "posposto" NON chiudono più il task: se è correlato/necessario
  va fatto (stessa PR o catena); se è davvero un task diverso, NON elencarlo qui.
  Per fix di pattern (regex/guard/floor/threshold/selector): fixa ogni sibling
  funnel-critical (AGENTS.md regola 6) — elencarlo qui lo tiene dovuto, non lo chiude.
  Per claim build/perf non validabile pre-merge: dichiara il trigger di revert.
  "Nessuno" = task completo e live.
-->
-
