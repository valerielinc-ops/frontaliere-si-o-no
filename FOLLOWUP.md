# Follow-up Triage Instructions

Contratto operativo per `post-merge-followup.yml`. Triage automatico post-merge: estrae lavoro residuo da PR body + reviewer comments, lo raccoglie in **una sola issue aggregata** con label `follow-up` per evitare evaporazione dello scope deferred.

## Scopo

Ogni 🟡 nit, ❓ q del reviewer bot e voce `## Non implementato` del PR body DEVE risultare in: (a) un item nella issue aggregata `follow-up` della PR, o (b) drop motivato. Nessun silent ignore. Filtra via scopo progetto (vedi `REVIEW.md` → "Scopo progetto").

## Input

- PR merged: `gh pr view $PR_NUMBER --json number,title,body,mergedAt,mergeCommit,url`
- Reviewer bot reviews: `gh api repos/$REPO/pulls/$PR_NUMBER/reviews` (filtra `user.type == "Bot"` + `user.login` starts `claude`)
- Issue esistenti collegate: `gh issue list --label follow-up --state all --search "PR #$PR_NUMBER" --json number,title,body`

## Parse rules

### Da PR body

Estrai sezione `## Non implementato (ancora)`. Ogni bullet `- **X** — Y` → candidate item.

- Voci con motivo `out of scope` o `posposto` → skip (esplicitamente droppate).
- Voci con motivo `follow-up`, `blocked`, `deferred`, o senza motivo → candidate issue.

### Da reviewer bot reviews

Parse il body markdown della review più recente. Per ogni riga:

- `🔴 Important: ...` → SKIP. 🔴 blocca merge, se la PR è merged significa che è stato fixato in-PR o droppato consapevolmente. Non creare follow-up per 🔴 retroattivi.
- `🟡 Nit: ...` → candidate issue.
- `❓ q: ...` → candidate issue (rephrase come "Verifica: <q>").
- `🟣 Pre-existing: ...` → candidate issue solo se file ancora presente nel diff (`gh pr diff`).
- `## Adversarial check` bullets → candidate issue per ogni voce (3 typical).

## Filtro scopo

Applica `REVIEW.md → "Scopo progetto"`. Item passa SE impatta monetizzazione / traffico organico / funnel reale. Altrimenti drop con rationale loggato nel commento di chiusura sulla PR.

### Hard-exclude: churn non-actionable (mai aprire follow-up)

Prima del filtro funnel, **droppa senza eccezioni** gli item che sono manutenzione documentale o pura igiene del codice, indipendentemente da chi li ha sollevati (PR body o reviewer). Questi non sono funnel-critici e auto-routano a `agent:fix` (#922) bruciando quota Max OAuth condivisa con la sessione interattiva owner. Il caso emblematico: `#896 → #907 → #1010 → PR #1011` ("de-rot line/PR anchors + document intent"), un follow-up doc che ha generato una PR il cui stesso body si dichiarava "puro churn documentale: nessun cambiamento di comportamento". Self-feed da fermare a monte.

Droppa (reason: `non-actionable-churn`) se l'item è essenzialmente uno di:

- **Doc/anchor/line-number rot**: "aggiorna line anchors", "i riferimenti `file:NNN` sono sfasati", "i link a PR #N nel commento sono stale", "de-rot comment".
- **"Document the intent / rationale"**: aggiungere commenti che spiegano codice già funzionante, senza cambio di comportamento.
- **Pure style/leggibilità/naming/format** non legati a un bug funnel.
- **Item che il reviewer stesso marca** `deferred` / `non funnel-critical` / `nit puro` (vedi `AGENTS.md → Post-merge feedback handling`, eccezione "drop senza issue").

Crea un follow-up SOLO quando l'item è **funnel-critico** (monetizzazione/traffico/correttezza) **E azionabile** (esiste un cambiamento di comportamento concreto da fare). Nel dubbio tra "non-actionable-churn" e "azionabile-funnel" pesa sul drop: una doc-nit persa costa zero al funnel, una issue churn-feed costa una run fixer sulla quota condivisa. Questa è la leva anti-burn più alta del workflow.

## Dedup

Tre livelli, in quest'ordine:
- **PR-level**: `gh issue list --label follow-up --state all --search "follow-up(#$PR_NUMBER)"` — se esiste già una issue aggregata per questa PR → **skip totale** (idempotenza re-run / backfill), log "already triaged #N". Mai una seconda issue aggregata per la stessa PR.
- **Item-level**, per ogni candidate: `gh issue list --label follow-up --state all --search "<keyword from item>"` — match titolo/sezione >70% similar → **escludi l'item** + log "duplicate of #N". Item che referenzia `#NNN` con issue/PR open → escludi l'item.
- **In-flight PR overlap** (anti self-flag): se l'item riguarda file specifici (path nel testo / `## Suggested action`), raccogli i file target ed esegui `gh pr list --state open --json number,title` + `gh pr diff <n> --name-only` sulle PR aperte. Se una PR aperta **già modifica** uno di quei file → **escludi l'item** + log "in-flight in PR #N". Razionale: un follow-up che indurisce/ritocca un file che un'altra PR sta già riscrivendo nasce obsoleto e fa partire il fixer su lavoro in corso (vedi `ISSUES.md → "Pre-condizioni — overlap-file"`). Nel dubbio (item non file-specifico) → non escludere.

Se dopo il dedup zero item sopravvivono → nessuna issue, summary "zero outstanding items".

## Issue format

**UNA sola issue aggregata per PR** (non N issue separate): tutti i candidate item validi diventano sezioni `### N.` della stessa issue. Motivo: con `follow-up` auto-routed a `agent:fix` (#922), N issue = N run fixer serializzate sulla quota Max OAuth condivisa con la sessione interattiva owner; 1 issue aggregata = 1 dispatch fixer. È la leva di frugalità più grossa sul volume di issue auto-generate (vedi `ISSUES.md → Frugalità quota` e `AGENTS.md → Auth automazioni & frugalità quota`).

```markdown
Title: follow-up(#<PR>): <N> item deferred — <PR short title>

Body:
## Origine
- PR: #<PR_NUMBER> <PR_TITLE> (merged <mergedAt>)
- URL: <PR url>

## Item

### 1. <one-line item>
- Source: <PR body Non implementato | reviewer 🟡 nit | reviewer ❓ q | adversarial check>
- Original text:
  > <verbatim>
- Funnel impact: <monetizzazione | traffico | funnel | none>
- Rationale: <perché passa il filtro>
- Suggested action: <concrete next step se ovvio dal contesto; altrimenti "investigate + decide drop or impl">

### 2. <one-line item>
- Source: ...
- Original text:
  > ...
- Funnel impact: ...
- Rationale: ...
- Suggested action: ...
```

Anche con UN solo candidate item la issue mantiene la forma aggregata (un'unica sezione `### 1.`) → formato uniforme, parsabile dal fixer.

Labels: `follow-up`, più UNO tra `funnel-monetization` / `funnel-seo` / `funnel-ux` per ogni funnel-area inferita dall'unione degli item (mix di item → più funnel-* label).

## Closing comment

Dopo aver creato la issue aggregata (o droppato tutti gli item), posta UN commento sulla PR riepilogativo:

```markdown
## Post-merge follow-up triage

Created: 1 aggregated issue #<id> con N item:
- <item1 one-line>
- <item2 one-line>

Dropped: M item
- "<verbatim>" — <reason: out-of-scope | dup-of-#X | non-funnel>

Skipped: P item (🔴 pre-merge or duplicate active follow-up)
```

Se zero item sopravvivono al filtro+dedup → posta `## Post-merge follow-up triage: zero outstanding items.` (nessuna issue creata).

## Supersede detection (comment-only, mai chiudere)

Dopo il triage, segnala le issue `follow-up` aperte che **questa PR potrebbe aver reso obsolete**, così non restano orfane (es. PR che riscrive un workflow rendendo moot gli item di hardening su quel file). **Non chiudere mai** su euristica: una PR può toccare un file senza coprire lo specifico item — chiudere distruggerebbe scope ancora valido. Solo l'autore, con `Closes #N` / `Supersedes #N` nel body (vedi `AGENTS.md → Workflow`), chiude davvero (GitHub nativo per `Closes`).

1. File toccati da questa PR: `gh pr diff $PR_NUMBER --name-only`.
2. Issue follow-up aperte: `gh issue list --label follow-up --state open --json number,title,body --limit 50` (escludi quella appena creata per questa PR).
3. Per ogni issue il cui body cita un file presente nel diff della PR (path match in `## Suggested action` / `## Item`):
   - Se non hai già commentato (cerca `🔗 Possibile supersede` nei commenti, idempotenza) → posta:
     ```markdown
     🔗 Possibile supersede: PR #<PR_NUMBER> (<PR_TITLE>) ha modificato `<file>` — <motivo dal PR title/body>. Verifica se gli item di questa issue sono ancora pertinenti; se coperti, chiudi a mano. (segnalazione automatica, non chiusura)
     ```
4. Nel summary commento sulla PR aggiungi una riga `Superseding flags: <N> issue segnalate (#a, #b)` se >0.

Solo segnalazione: il giudizio finale resta umano. Mai più di un commento di supersede per coppia (PR, issue).

## Constraint

- Read-only su tutto eccetto: `gh issue create`, `gh pr comment`, `gh issue comment` (solo per la Supersede detection — segnalazione, mai chiusura).
- Mai modificare label/state/title della PR.
- Mai chiudere/riaprire issue (nemmeno le superseded — solo commento).
- Zero finding accettabile (PR LGTM puro senza Non implementato). NON inventare.
- Incerto sul filtro scopo → crea issue comunque, rationale "needs triage". Drop è più costoso di una issue extra.
- Limite hard: max 10 item nella issue aggregata. Oltre → includi i primi 10 e aggiungi in coda al summary "throttled: >10 item, restanti richiedono triage manuale".
