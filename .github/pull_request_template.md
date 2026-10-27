<!--
  Completeness contract (REVIEW.md / AGENTS.md § Workflow).
  Questo template, AGENTS.md e ISSUES.md condividono la stessa tassonomia:
  `scripts/lib/pr-body-sections-check.mjs` è la fonte di verità per il parser.
  Le DUE sezioni qui sotto sono OBBLIGATORIE — il reviewer e pr-body-contract.yml
  le leggono per il gating. Non rinominarle (no `## Fix`, `## Verify`, `## Effetto`):
  il check cerca i due header letterali `## Implementato` e `## Non implementato`.
  Closes #N / Supersedes #N se la PR rende moot un'issue aperta.
  Per chiudere PIÙ issue: una keyword per issue, una per riga —
    Closes #12
    Closes #34
  MAI `Closes #12 #34 #56` su una riga: GitHub chiude solo #12, il resto resta
  aperto (cfr. PR #1320). pr-body-contract.yml flagga la riga multi-issue.
  MAI `Closes #N` se #N è una follow-up AGGREGATA (in particolare un bucket
  `follow-up(daily:YYYY-MM-DD)`). `Closes` scatta al merge e chiuderebbe il bucket
  con item ancora dovuti — pr-body-contract.yml la flagga e la PR nasce rossa
  (cfr. #5848, #5862). Scrivi `Addresses #N` e, per una fix giornaliera, anche
  `Follow-up item: FU-YYYY-MM-DD-NNN`; reconcile-followups.mjs chiude il bucket
  soltanto quando TUTTI gli item validi sono fatti.
  Nel dubbio non tirare a indovinare, calcolala dal record dell'issue:
    gh issue view N --json number,title,body,labels \
      | node scripts/lib/pr-body-generator-contract.mjs --closing-ref
  `Closes #N` vale per una issue ordinaria singola; `Addresses #N` vale per una
  follow-up aggregata multi-item o per una issue chiusa da un monitor sulla
  misura. Per un bucket daily aggiungi anche un solo `Follow-up item: FU-...`.
  Prima di creare la PR usa sempre `node scripts/ci/pr-body-check-gate.mjs --body-file <file>`;
  il wrapper rifiuta body inline o senza il file canonico.

  Ogni bullet non vuoto in `## Non implementato (ancora)` deve dichiarare uno
  stato riconosciuto: `in questa PR`, `PR concatenata #N`, `per scelta`,
  `by construction`, `falso positivo`, `blocked: <causa esterna reale>` o
  `blocked: decisione del proprietario` (`blocked: owner decision` è sinonimo).
  `PR concatenata` senza `#N` non è tracciabile. `blocked:` tecnico mantiene il
  lavoro aperto; gli stati decisionali (`per scelta`, `by construction`,
  `falso positivo` e owner decision) richiedono nello stesso bullet
  `**Motivo:** <causa concreta>. **Prossimo passo:** <azione concreta>.`.
  La negazione di `falso positivo` non chiude il bullet: `non è un falso
  positivo` resta lavoro dovuto. `Nessuno` indica che non resta scope.
-->

## Implementato

<!-- Cosa fa la PR. Bullet concreti: file/comportamento cambiato. -->
-

<!-- Per una fix di un bucket daily: usa `Addresses #N` e indica un solo
     `Follow-up item: FU-YYYY-MM-DD-NNN`; non lavorare più item nella stessa PR. -->

## Non implementato (ancora)

<!--
  PIANO DI COMPLETAMENTO del task, NON scope-deferito-e-chiuso (AGENTS.md #8).
  Il task è chiuso SOLO quando questa sezione legge "Nessuno". Ogni voce è lavoro
  ancora DOVUTO: indica lo stato/next-step, non un motivo-scappatoia.
    - <scope> — in questa PR
    - <scope> — PR concatenata #N (in arrivo)
    - <scope> — blocked: <causa esterna reale>
    - <decisione> — per scelta — **Motivo:** <causa concreta>. **Prossimo passo:** <azione concreta>.
  "out of scope" / "posposto" NON chiudono più il task: se è correlato/necessario
  va fatto (stessa PR o catena); se è davvero un task diverso, NON elencarlo qui.
  Per fix di pattern (regex/guard/floor/threshold/selector): fixa ogni sibling
  funnel-critical (AGENTS.md regola 6) — elencarlo qui lo tiene dovuto, non lo chiude.
  Per claim build/perf non validabile pre-merge: dichiara il trigger di revert.
  "Nessuno" = task completo e live.
-->
-
