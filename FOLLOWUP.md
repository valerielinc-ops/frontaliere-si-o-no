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

Prima di creare issue:
- `gh issue list --label follow-up --state all --search "<keyword from item>"` — se match titolo >70% similar → skip + log "duplicate of #N".
- Cerca link a issue/PR nel testo dell'item (`#NNN`) → se referenziato issue/PR open → skip.

## Issue format

```markdown
Title: follow-up(#<PR>): <one-line item>

Body:
## Origine
- PR: #<PR_NUMBER> <PR_TITLE> (merged <mergedAt>)
- Source: <PR body Non implementato | reviewer 🟡 nit | reviewer ❓ q | adversarial check>
- Original text:
  > <verbatim>

## Scope filter
- Funnel impact: <monetizzazione | traffico | funnel | none>
- Rationale: <perché passa il filtro>

## Suggested action
<concrete next step se ovvio dal contesto; altrimenti "investigate + decide drop or impl">
```

Labels: `follow-up`, e UNO tra `funnel-monetization` / `funnel-seo` / `funnel-ux` se inferibile dal scope filter.

## Closing comment

Dopo aver creato issue (o droppato item), posta UN commento sulla PR riepilogativo:

```markdown
## Post-merge follow-up triage

Created: N issue
- #<id1> <title1>
- #<id2> <title2>

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
- Incerto sul filtro scopo → crea issue comunque, rationale "needs triage". Drop è più costoso di una issue extra.
- Limite hard: max 10 issue create per PR. Oltre → posta commento "throttled, manual triage needed" e termina.
