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
-->

## Implementato

<!-- Cosa fa la PR. Bullet concreti: file/comportamento cambiato. -->
-

## Non implementato (ancora)

<!--
  Scope NON fatto + motivo: out of scope / follow-up / blocked / posposto.
  Per fix di pattern (regex/guard/floor/threshold/selector): elenca ogni sibling
  funnel-critical NON toccato e perché (AGENTS.md regola 6).
  Per claim build/perf non validabile pre-merge: dichiara il trigger di revert.
  "Nessuno" è una risposta valida se la PR è completa.
-->
-
