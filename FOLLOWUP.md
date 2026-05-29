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

## Dedup

Due livelli, in quest'ordine:
- **PR-level**: `gh issue list --label follow-up --state all --search "follow-up(#$PR_NUMBER)"` — se esiste già una issue aggregata per questa PR → **skip totale** (idempotenza re-run / backfill), log "already triaged #N". Mai una seconda issue aggregata per la stessa PR.
- **Item-level**, per ogni candidate: `gh issue list --label follow-up --state all --search "<keyword from item>"` — match titolo/sezione >70% similar → **escludi l'item** + log "duplicate of #N". Item che referenzia `#NNN` con issue/PR open → escludi l'item.

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

## Constraint

- Read-only su tutto eccetto: `gh issue create`, `gh pr comment`.
- Mai modificare label/state/title della PR.
- Mai chiudere/riaprire issue.
- Zero finding accettabile (PR LGTM puro senza Non implementato). NON inventare.
- Incerto sul filtro scopo → crea issue comunque, rationale "needs triage". Drop è più costoso di una issue extra.
- Limite hard: max 10 item nella issue aggregata. Oltre → includi i primi 10 e aggiungi in coda al summary "throttled: >10 item, restanti richiedono triage manuale".
