# Follow-up Triage Instructions

Contratto operativo per `post-merge-followup.yml`. Triage automatico post-merge: estrae lavoro residuo da PR body + reviewer comments, crea issue con label `follow-up` per evitare evaporazione dello scope deferred.

## Scopo

Ogni 🟡 nit, ❓ q del reviewer bot e voce `## Non implementato` del PR body DEVE risultare in: (a) issue con label `follow-up`, o (b) drop motivato. Nessun silent ignore. Filtra via scopo progetto (vedi `REVIEW.md` → "Scopo progetto").

## Input

- PR merged: `gh pr view $PR_NUMBER --json number,title,body,mergedAt,mergeCommit,url`
- Reviewer bot reviews: `gh api repos/$REPO/pulls/$PR_NUMBER/reviews` (filtra `user.type == "Bot"` + `user.login` starts `claude`)
- Issue esistenti collegate: `gh issue list --label follow-up --state all --search "PR #$PR_NUMBER" --json number,title,body`

## Parse rules

### Da PR body

Estrai sezione `## Non implementato (ancora)`. Ogni bullet `- **X** — Y` → candidate item.

- Voci con motivo `out of scope` o `posposto` → skip (esplicitamente droppate).
- Voci con motivo `follow-up`, `blocked`, `deferred`, o senza motivo → candidate item (entreranno nella checklist unica).

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

Prima di creare issue:
- `gh issue list --label follow-up --state all --search "<keyword from item>"` — se match titolo >70% similar → skip + log "duplicate of #N".
- Cerca link a issue/PR nel testo dell'item (`#NNN`) → se referenziato issue/PR open → skip.

## Issue format — UNA issue per PR (batch, anti-storm)

**Mai una issue per item.** Tutti i candidate validi di una PR vanno in UNA sola issue con checklist. Riduce lo storm (era N issue/PR, es. #845→5, #852→6) a 1 issue/PR.

```markdown
Title: follow-up(#<PR>): <N> item post-merge

Body:
## Origine
- PR: #<PR_NUMBER> <PR_TITLE> (merged <mergedAt>) — <url>

## Checklist
- [ ] **<one-line item>** — _source: <Non implementato | 🟡 nit | ❓ q | adversarial>_ · funnel: <monetizzazione|traffico|funnel|none> · azione: <next step o "investigate">
  > <verbatim, se utile>
- [ ] **<item 2>** — ...
- [ ] ...
```

Se esiste già una issue aperta `follow-up(#<PR>)` → aggiungi i nuovi item alla sua checklist via `gh issue edit --body`, NON crearne un'altra.

Labels: `follow-up`, e UNO tra `funnel-monetization` / `funnel-seo` / `funnel-ux` se la maggioranza degli item è inferibile a quel funnel.

## Closing comment

Dopo aver creato issue (o droppato item), posta UN commento sulla PR riepilogativo:

```markdown
## Post-merge follow-up triage

Created: 1 issue #<id> (<N> item in checklist)
- <item 1>
- <item 2>

Dropped: M item
- "<verbatim>" — <reason: out-of-scope | dup-of-#X | non-funnel>

Skipped: P item (🔴 pre-merge or duplicate active follow-up)
```

Se zero issue create + zero drop → posta `## Post-merge follow-up triage: zero outstanding items.`

## Constraint

- Read-only su tutto eccetto: `gh issue create`, `gh pr comment`.
- Mai modificare label/state/title della PR.
- Mai chiudere/riaprire issue.
- Zero finding accettabile (PR LGTM puro senza Non implementato). NON inventare.
- Incerto sul filtro scopo → includi l'item nella checklist con nota "needs triage". Drop è più costoso di una riga checklist.
- **Limite hard: 1 issue per PR** (batch checklist). Mai aprire una seconda issue per la stessa PR.
