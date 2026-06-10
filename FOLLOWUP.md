# Follow-up Triage Instructions

Contratto operativo per `post-merge-followup.yml`. Triage automatico post-merge: estrae lavoro residuo da PR body + reviewer comments, lo raccoglie in **una sola issue aggregata** con label `follow-up` per evitare evaporazione dello scope deferred.

## Scopo

Ogni 🟡 nit, ❓ q del reviewer bot e voce `## Non implementato` del PR body DEVE risultare in: (a) un item nella issue aggregata `follow-up` della PR, (b) drop motivato, o (c) — se è pura verifica del sito live senza file da editare — una voce nella checklist `Live-verification` batchata del commento di chiusura (nessuna issue, nessun fixer; vedi `## Filtro scopo → Hard-exclude: live-verification-only item`). Nessun silent ignore. Filtra via scopo progetto (vedi `REVIEW.md` → "Scopo progetto").

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

### Hard-exclude: missing-test nit (mai aprire follow-up)

Categoria a sé, **droppata sempre** (reason: `missing-test-nit`), prima del filtro funnel, **a prescindere dalla fonte** (reviewer 🟡/❓/adversarial OPPURE PR body `## Non implementato`) e **anche se l'item è funnel-critico**. L'owner non dà valore alla copertura test come deliverable: i test-nit sono alto-volume / basso-valore, auto-routano a `agent:fix` (#922) e bruciano quota Max condivisa; storicamente done-but-open (#865/#908/#854 erano già coperti da PR successive). Idealmente il reviewer non li emette più (`REVIEW.md → IGNORA → test coverage`), ma questa resta la cintura per i residui e per gli item dal PR body.

Droppa se l'item è essenzialmente uno di:

- "Manca un test per X" / "aggiungere test coverage" / "committare i test citati nel PR body" / "pinnare il comportamento con un test" / "test mancante sul ramo/path Y".
- Voce adversarial-check che lamenta assenza di test invece di un rischio di comportamento.

**NON droppare** (resta in scope normale): un BUG in un test ESISTENTE — assertion sbagliata, regex/guard leaky che resta verde sulla regressione, fixture con date assolute (#1035) — è correttezza, non coverage.

### Hard-exclude: live-verification-only item (mai aprire follow-up — batch in checklist)

Categoria a sé, **mai mintata come issue `follow-up`** (reason: `live-verify-only`), prima del filtro funnel, **a prescindere dalla fonte** (reviewer 🟡/❓/adversarial OPPURE PR body `## Non implementato` / `## Test plan` checkbox `- [ ]` non spuntata). Un item è `live-verify-only` quando l'**unica azione suggerita è verificare il sito già deployato** — non esiste alcun file da editare, serve un sito live + occhi umani (o uno strumento E2E manuale). Il fix di codice della PR è già mergiato ed è meccanicamente sano; "controlla che renda bene in prod" non è una issue fixabile da `agent:fix`. Storicamente ~40% dei sub-item follow-up sono di questo tipo (classe #1149/#959/#1129): auto-routano a `agent:fix` → il fixer non ha nulla da editare → PR vuota/no-op → `pr-review-loop` la revisiona → giri Claude sprecati sulla quota Max condivisa. È, dopo il missing-test, la seconda voce di burn più alta del workflow.

Riconosci `live-verify-only` dalle frasi-segnale nell'item (l'azione è SOLO ispezione runtime, nessuna edit di file):

- "verify live" / "verifica live" / "post-deploy" / "(post-merge, live)" / "(live)" / "controlla in prod" / "su prod" / "una volta deployato".
- "curl" la URL di produzione / "live-200" / "live curl" / controllo HTTP status sul sito live.
- "render at NNNpx" / "renderizza a 382px" / "apri DevTools" / "ispeziona nel browser" / "Playwright hydration" / verifica visuale o CLS a runtime.
- Checkbox `## Test plan` `- [ ]` esplicitamente etichettata `(post-merge, live)` / `(live)` / "verifica post-deploy" e non spuntata (il reviewer la flagga 🟡 "ricorda spunta post-merge", vedi `REVIEW.md → Test plan compliance`).

**Routing (NON drop silenzioso):** questi item NON diventano issue, ma confluiscono in **un'unica checklist batchata** nella sezione `Live-verification` del commento di chiusura sulla PR (vedi `## Closing comment`). Restano visibili all'owner per la verifica manuale post-deploy, senza far partire alcun fixer. Una sola checklist per PR, mai una issue per voce.

**NON classificare `live-verify-only`** (resta candidate normale, può diventare issue) un item che **mescola** un suffisso live-verify con un'azione reale su un file: se l'item descrive anche un cambiamento di codice/config concreto da fare ("aggiungi `min-height` a `AdSlot.tsx` E poi verifica il CLS live"), la parte editabile è azionabile → resta in scope normale (la coda live-verify è solo conferma). Solo gli item la cui **intera** azione è ispezione runtime sono `live-verify-only`. Nel dubbio tra "puro live-verify" e "ha anche un'edit" → tienilo actionable (non batcharlo): un'edit persa costa al funnel, una checklist-entry in più costa zero.

**Override deterministico (presenza di file-path = actionable):** prima di classificare `live-verify-only` sulle frasi-segnale, controlla se il testo dell'item (`Original text` + `## Suggested action`) contiene un **token che è un percorso file editabile** — un path-like che termina in `.tsx` / `.ts` / `.mjs` / `.js` / `.yml` / `.yaml` / `.json` / `.md` / `.css` (es. `scripts/foo.mjs`, `components/Bar.tsx`, `build-plugins/baz.ts`). Se sì → **classifica `actionable`** (resta candidate normale) **a prescindere** dalle frasi-segnale live-verify. Razionale: un item puramente live-verify ("controlla che renda bene in prod") non nomina mai un file da editare; la presenza di un path è il segnale forte che esiste un'edit concreta, e il giudizio prompt-driven sul "mescola" qui sopra rischia di batchare (= perdere) un fix funnel-critico. Questo override è deterministico e non dipende dal giudizio dell'agente. (Eccezione naturale: un'URL di prod come `/sitemap.xml` non è un path-token editabile — `.xml`/`.html` non sono nella lista, restano live-verify.)

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

Live-verification (manuale post-deploy, nessuna issue/fixer): Q item
- [ ] "<verbatim>" — <segnale: post-deploy | curl prod | render NNNpx | DevTools/Playwright>

Dropped: M item
- "<verbatim>" — <reason: out-of-scope | dup-of-#X | non-funnel | non-actionable-churn | missing-test-nit>

Skipped: P item (🔴 pre-merge or duplicate active follow-up)
```

La sezione `Live-verification` raccoglie **tutti** gli item `live-verify-only` (vedi `## Filtro scopo → Hard-exclude: live-verification-only item`): checklist `- [ ]` batchata, una sola per PR, **nessuna issue creata e nessun fixer dispatchato** — è solo un promemoria per la verifica manuale dell'owner sul sito deployato. Ometti la sezione se Q=0. Mai promuovere una voce live-verify a issue.

Se zero item sopravvivono al filtro+dedup (e nessuna voce live-verify) → posta `## Post-merge follow-up triage: zero outstanding items.` (nessuna issue creata). Se sopravvivono SOLO voci live-verify (zero issue) → posta il summary con la sola sezione `Live-verification` e la riga `Created: 0 issue (solo live-verification batchata)`.

## Supersede detection → spostata su `followup-reconcile` (deterministica, zero-Claude)

**2026-06-04:** la supersede detection è stata RIMOSSA dal prompt Claude di `post-merge-followup.yml`. Il flag grossolano su file-touch (comment-only, advisory) bruciava turni Claude + un `gh issue list --search` per-file a ogni merge, per una segnalazione che l'autore raramente azionava. La copertura è ora di `followup-reconcile.yml` (`scripts/ci/reconcile-followups.mjs`, cron daily, **zero-Claude**): per ogni issue `follow-up` aperta estrae i file/token citati e verifica se la fix è **presente verbatim** nel file.

**2026-06-10 — auto-close a due tier (drena la pila `maybe-resolved` senza perdere qualità).** Il vecchio "la chiusura resta umana" lasciava i `maybe-resolved` deterministicamente-rilevati a un umano che non arrivava → la coda non convergeva mai (driver #1 del treadmill). Ora `reconcile` chiude in autonomia, ma SOLO con **doppia conferma separata nel tempo** + più veti di sicurezza:

1. **1ª detection** (issue non ancora `maybe-resolved`) → commento advisory + label `maybe-resolved`. **Finestra di grazia**: l'umano ha fino al run successivo per obiettare (rimuovere la label, aggiungere `keep-open`/`pinned`, riaprire lo scope).
2. **2ª conferma** (la issue porta GIÀ `maybe-resolved` da un run precedente, è ANCORA risolta, ha il nostro commento-marker, è **single-item**, **non** ha label keep-open/strategica, e l'evidenza è **forte**) → **auto-close** `--reason completed` + label `fu-resolved-auto`.

Veti all'auto-close (restano flag→umano): **multi-item aggregati** (`N item`, N≥2 — un sub-item prose-only non contribuisce token, "tutti i token presenti" non prova che ogni item sia fatto); label **keep-open/pinned/revenue/tracker/do-not-close**; **evidenza debole** (singolo token poco specifico tipo `meta.model`, 1 solo segno di punteggiatura — `isStrongAutoCloseEvidence` esige ≥2 token distinti OPPURE 1 token "ricco" con ≥2 segni). Rimozione della label dopo il flag = **obiezione umana** → il bot tace. La chiusura è **reversibile** (si riapre da sola se il segnale ricorre, titoli monitor dedup-stabili). Kill-switch: repo-var `RECONCILE_NO_AUTOCLOSE=1` o input `no_autoclose` → torna flag-only. Logica pura testata in `tests/reconcile-followups-decision.test.ts`; matcher condiviso con il pre-flight di `issue-fix` (`followup-resolution-match.mjs`, AGENTS.md #6).

Gap residuo accettato: un refactor che rende moot un item SENZA aggiungere i token citati non viene flaggato (reconcile cerca i token verbatim). Trade-off scelto per ridurre la spesa Claude per-merge.

## Constraint

- Read-only su tutto eccetto: `gh issue create`, `gh pr comment`.
- Mai modificare label/state/title della PR.
- Mai chiudere/riaprire issue.
- Zero finding accettabile (PR LGTM puro senza Non implementato). NON inventare.
- Incerto sul filtro scopo → crea issue comunque, rationale "needs triage". Drop è più costoso di una issue extra.
- Limite hard: max 10 item nella issue aggregata. Oltre → includi i primi 10 e aggiungi in coda al summary "throttled: >10 item, restanti richiedono triage manuale".
