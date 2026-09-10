# Follow-up Triage Instructions

Contratto operativo per `post-merge-followup.yml`. Il triage automatico post-merge estrae
lavoro residuo da PR body + reviewer comments e lo raccoglie in un bucket giornaliero
`follow-up` per repository target. Non esiste più una issue per PR: per ogni chiave di
giorno riuscito e per ogni repository target può esistere al massimo un bucket.

## Contratto corrente — bucket giornaliero

La forma canonica è:

```text
follow-up(daily:YYYY-MM-DD): N item — owner/repo
```

La chiave è il giorno della run di triage riuscita in `Europe/Zurich`, mai `mergedAt`.
Il watermark resta l'inizio dell'ultima run riuscita: una run fallita non lo avanza e
il retry rilegge la stessa finestra. Il commento `## Post-merge follow-up triage` resta
obbligatorio su ogni PR e continua a essere il marker di idempotenza per-PR, anche
quando i finding della PR vengono aggiunti a un bucket già esistente.

Una PR di fix daily che porta `Addresses #<bucket>` e `Follow-up item: FU-...` non
genera un nipote: il gate la lascia passare soltanto per cercare finding nuovi. Quelli
già coperti dal padre si deduplicano/aggiornano in `Sources`; quelli genuinamente nuovi
si aggiungono al bucket padre (riportandolo a `collecting` se era `sealed`, poi il gate
lo risigilla). Se il padre non è leggibile, si segnala il blocco sulla PR e non si crea
un contenitore alternativo.

Ogni bucket ha il ciclo `State: collecting` → `State: sealed`. Durante la raccolta il
bucket non porta `agent:fix` né `agent:fix-queued`; il gate deterministico finale
riusa `hasFalsifiableAcceptance()` e, solo dopo aver completato tutti i chunk, demota
gli item non verificabili, sigilla il corpo e aggiunge `agent:fix-queued`. Un errore
lascia il bucket `collecting` e non deve perdere né item né watermark.

Ogni item usa un ID stabile `FU-YYYY-MM-DD-NNN` e contiene almeno `State`, `Sources`,
`Target repository`, `Target file`, `Original text`, `Suggested action` e `Acceptance
token`. Il fingerprint di dedup è `target repository + target file + token/azione
normalizzata`; un match accorpa le PR nella riga `Sources` invece di duplicare l'item.
Le append concorrenti richiedono lettura immediatamente precedente, confronto della
baseline e ricostruzione dell'append su una lettura nuova in caso di divergenza; gli
eventi di sealing/demozione vanno anche in commenti append-only.

Il drainer promuove un bucket solo se è `sealed`, esiste un item `open` e non c'è già
una PR aperta che dichiara quel suo ID. `issue-fix` seleziona un solo item `open` per
run. Una PR parziale usa sempre `Addresses #<bucket>` e `Follow-up item:
FU-YYYY-MM-DD-NNN`, mai `Closes #<bucket>`; il reconciler marca gli item uno per uno
con evidenza e chiude il bucket soltanto quando tutti gli item validi sono `done` e
provati. Body illeggibile, stato ambiguo, acceptance assente o prova debole lasciano
il lavoro aperto.

## Gate grandchild-suppression (zero-Claude, PRIMA del triage)

`post-merge-followup.yml` gira su OGNI PR mergiata dall'owner — **incluse le PR che FIXANO un follow-up**. Senza guardia il loop è self-perpetuante by-construction:

> follow-up #A → fix PR → merge → reviewer lascia un 🟡 → **nuovo follow-up #B (nipote)** → fix PR → … all'infinito.

Il treadmill brucia **~470 run Claude/sett** (×~3 run l'una: triage → `issue-fix` → `pr-review-loop`) sulla quota Max OAuth **condivisa** con la sessione interattiva owner (vedi `AGENTS.md → Auth automazioni & frugalità quota`).

Lo step deterministico `scripts/ci/is-followup-fix-pr.mjs` (zero-Claude) gira **prima** dello step Claude e salta i normali fixer branch che puntano a una issue `follow-up`: niente nipote + run Claude risparmiata. Una fix daily con entrambi i marker `Addresses #<bucket>` e `Follow-up item: FU-...` riceve invece una deroga limitata: il collector la include solo per cercare finding nuovi e li aggiunge al bucket **padre**, mai a una nuova issue. Lo scope deferred di un fix-di-follow-up, se reale, appartiene alla issue padre (resta aperta finché non risolta del tutto). **Proceed-safe**: branch/body illeggibile o `gh issue view` in errore → triage normale, mai perdere un follow-up di PR organica.

## Scopo

Ogni 🟡 nit, ❓ q del reviewer bot e voce `## Non implementato` del PR body DEVE risultare in: (a) un item nel bucket giornaliero `follow-up` del repository target, (b) drop motivato, o (c) — se è pura verifica del sito live senza file da editare — una voce nella checklist `Live-verification` batchata del commento di chiusura (nessuna issue, nessun fixer; vedi `## Filtro scopo → Hard-exclude: live-verification-only item`). Nessun silent ignore. Filtra via scopo progetto (vedi `REVIEW.md` → "Scopo progetto").

## Input

- PR merged: `gh pr view $PR_NUMBER --json number,title,body,mergedAt,mergeCommit,url`
- Reviewer bot reviews: `gh api repos/$REPO/pulls/$PR_NUMBER/reviews` (filtra `user.type == "Bot"` + `user.login` starts `claude`)
- Issue esistenti collegate: `gh issue list --label follow-up --state all --search "PR #$PR_NUMBER" --json number,title,body`

## Parse rules

### Da PR body

Estrai sezione `## Non implementato (ancora)`. Ogni bullet `- **X** — Y` → candidate item.

**Post-#8 (`AGENTS.md → Non-Negotiable #8`): `## Non implementato` NON è scope-deferito-e-chiuso, è il piano di completamento di un task ancora APERTO.** Idealmente l'agente lo svuota in-task (PR concatenate) e questa sezione legge «Nessuno» → zero candidate. Quando invece resta scope dovuto, va **tracciato a completamento**, non droppato:

- `Nessuno` / sezione vuota → nessun candidate (task completo).
- Voci `blocked: <causa esterna reale>` → candidate issue (label `blocked`), tracciate fino a sblocco.
- **Ogni altra voce di scope dovuto → candidate issue** (il task non è chiuso finché non è fatta). Il vecchio skip su motivo `out of scope` / `posposto` è **ABOLITO**: non sono più scappatoie di chiusura. Restano fuori solo le categorie hard-exclude qui sotto (churn non-actionable / missing-test / live-verify-only), che non sono scope-feature.

**Il routing lo decide lo STATO LETTERALE del bullet**, ed è già codificato — `scripts/ci/followup-has-candidates.mjs` importa `bulletState()` da `scripts/lib/pr-body-sections-check.mjs`, che è la sola definizione della tassonomia. Questo elenco la descrive, non la duplica:

| stato dichiarato | candidate? | perché |
|---|---|---|
| `in questa PR` | no | è già nel diff mergiato |
| `PR concatenata #N` | no | ha già il suo tracciamento: la issue sarebbe un doppione |
| `per scelta` / `by construction` | no | è un no motivato, non un rinvio |
| `blocked: decisione del proprietario` | no | deciso da chi decide |
| `blocked: <causa tecnica>` | **sì** | lavoro sospeso su una causa esterna: va riaperto |
| **nessuno stato dichiarato** | **sì** | fail-safe: un residuo non qualificato è lavoro potenzialmente dovuto, e tacerlo è peggio che generare una traccia |

L'ultima riga è la ragione per cui l'advisory `bullet-without-state` del gate non va promosso a duro finché i generatori non sono a zero: finché i bullet senza stato esistono, sono la classe più numerosa, e filtrarli qui aprirebbe una finestra cieca proprio su di essa.

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

Prima del filtro funnel, **droppa senza eccezioni** gli item che sono manutenzione documentale o pura igiene del codice, indipendentemente da chi li ha sollevati (PR body o reviewer). Questi non sono funnel-critici e auto-routano a `agent:fix` (#922) bruciando quota condivisa. Caso emblematico `#896 → #907 → #1010 → PR #1011` ("de-rot line/PR anchors + document intent"): un follow-up doc che ha generato una PR dichiaratamente "puro churn documentale, nessun cambio di comportamento". Self-feed da fermare a monte.

Droppa (reason: `non-actionable-churn`) se l'item è essenzialmente uno di:

- **Doc/anchor/line-number rot**: "aggiorna line anchors", "i riferimenti `file:NNN` sono sfasati", "i link a PR #N nel commento sono stale", "de-rot comment".
- **"Document the intent / rationale"**: aggiungere commenti che spiegano codice già funzionante, senza cambio di comportamento.
- **Pure style/leggibilità/naming/format** non legati a un bug funnel.
- **Item che il reviewer stesso marca** `deferred` / `non funnel-critical` / `nit puro` (vedi `AGENTS.md → Post-merge feedback handling`, eccezione "drop senza issue").

### Hard-exclude: missing-test nit (mai aprire follow-up)

Categoria a sé, **droppata sempre** (reason: `missing-test-nit`), prima del filtro funnel, **a prescindere dalla fonte** (reviewer 🟡/❓/adversarial OPPURE PR body `## Non implementato`) e **anche se l'item è funnel-critico**. L'owner non dà valore alla copertura test come deliverable: i test-nit sono alto-volume / basso-valore, auto-routano a `agent:fix` (#922) e bruciano quota condivisa; storicamente done-but-open (#865/#908/#854 già coperti da PR successive). Idealmente il reviewer non li emette più (`REVIEW.md → IGNORA → test coverage`), ma questa resta la cintura per i residui e per gli item dal PR body.

Droppa se l'item è essenzialmente uno di:

- "Manca un test per X" / "aggiungere test coverage" / "committare i test citati nel PR body" / "pinnare il comportamento con un test" / "test mancante sul ramo/path Y".
- Voce adversarial-check che lamenta assenza di test invece di un rischio di comportamento.

**NON droppare** (resta in scope normale): un BUG in un test ESISTENTE — assertion sbagliata, regex/guard leaky che resta verde sulla regressione, fixture con date assolute (#1035) — è correttezza, non coverage.

### Hard-exclude: live-verification-only item (mai aprire follow-up — batch in checklist)

Categoria a sé, **mai mintata come issue `follow-up`** (reason: `live-verify-only`), prima del filtro funnel, **a prescindere dalla fonte** (reviewer 🟡/❓/adversarial OPPURE PR body `## Non implementato` / `## Test plan` checkbox `- [ ]` non spuntata). Un item è `live-verify-only` quando l'**unica azione suggerita è verificare il sito già deployato** — non esiste alcun file da editare, serve un sito live + occhi umani (o uno strumento E2E manuale). Il fix di codice della PR è già mergiato ed è meccanicamente sano; "controlla che renda bene in prod" non è una issue fixabile da `agent:fix`: il fixer non ha nulla da editare → PR vuota/no-op → `pr-review-loop` spreca giri Claude. Storicamente ~40% dei sub-item follow-up (classe #1149/#959/#1129); dopo il missing-test, la seconda voce di burn più alta del workflow.

Riconosci `live-verify-only` dalle frasi-segnale nell'item (l'azione è SOLO ispezione runtime, nessuna edit di file):

- "verify live" / "verifica live" / "post-deploy" / "(post-merge, live)" / "(live)" / "controlla in prod" / "su prod" / "una volta deployato".
- "curl" la URL di produzione / "live-200" / "live curl" / controllo HTTP status sul sito live.
- "render at NNNpx" / "renderizza a 382px" / "apri DevTools" / "ispeziona nel browser" / "Playwright hydration" / verifica visuale o CLS a runtime.
- Checkbox `## Test plan` `- [ ]` esplicitamente etichettata `(post-merge, live)` / `(live)` / "verifica post-deploy" e non spuntata (il reviewer la flagga 🟡 "ricorda spunta post-merge", vedi `REVIEW.md → Test plan compliance`).

**Routing (NON drop silenzioso):** questi item NON diventano issue, ma confluiscono in **un'unica checklist batchata** nella sezione `Live-verification` del commento di chiusura sulla PR (vedi `## Closing comment`). Restano visibili all'owner per la verifica manuale post-deploy, senza far partire alcun fixer. Una sola checklist per PR, mai una issue per voce.

**NON classificare `live-verify-only`** (resta candidate normale, può diventare issue) un item che **mescola** un suffisso live-verify con un'azione reale su un file ("aggiungi `min-height` a `AdSlot.tsx` E poi verifica il CLS live"): la parte editabile è azionabile → resta in scope normale (la coda live-verify è solo conferma). Solo gli item la cui **intera** azione è ispezione runtime sono `live-verify-only`. Nel dubbio → tienilo actionable (non batcharlo): un'edit persa costa al funnel, una checklist-entry in più costa zero.

**Override deterministico (presenza di file-path = actionable):** prima di classificare `live-verify-only` sulle frasi-segnale, controlla se il testo dell'item (`Original text` + `## Suggested action`) contiene un **token che è un percorso file editabile** — un path-like che termina in `.tsx` / `.ts` / `.mjs` / `.js` / `.yml` / `.yaml` / `.json` / `.md` / `.css` (es. `scripts/foo.mjs`, `components/Bar.tsx`, `build-plugins/baz.ts`). Se sì → **classifica `actionable`** (resta candidate normale) **a prescindere** dalle frasi-segnale live-verify. Razionale: un item puramente live-verify non nomina mai un file da editare; la presenza di un path è il segnale forte che esiste un'edit concreta, e il giudizio prompt-driven sul "mescola" qui sopra rischia di batchare (= perdere) un fix funnel-critico. Override deterministico, non dipende dal giudizio dell'agente. (Eccezione naturale: un'URL di prod come `/sitemap.xml` non è un path-token editabile — `.xml`/`.html` non sono nella lista, restano live-verify.)

### Hard-exclude: no-acceptance-condition — ora ANCHE un gate deterministico dopo il conio

La regola («un item entra in coda solo se la sua `Suggested action` cita fra backtick almeno un token-codice distintivo») è scritta nel prompt di `post-merge-followup.yml`, e finché è vissuta solo lì è una richiesta a un LLM, non un invariante. Misurato il 2026-09-06 sul sito, ultimi 7 giorni: 164 aggregate coniate, **91 immortali per costruzione (55% = 13,0/giorno)** — 76 senza nemmeno un item falsificabile, 15 con un corpo non spezzabile in item. Una `no-valid-item` non si chiude MAI: `aggregateCloseGate()` la blocca per costruzione, perché chiuderla sarebbe chiudere su evidenza assente (#5849).

Dal 2026-09-06 lo step `Gate sul conio` (`scripts/ci/gate-minted-followups.mjs`, zero-Claude, subito dopo la sessione Claude) rilegge la issue appena creata e applica la regola con lo **stesso** oracolo che poi chiude l'item — `hasFalsifiableAcceptance()` in `scripts/ci/followup-resolution-match.mjs`, importato, mai reimplementato: usarne uno più permissivo in apertura è ciò che ha prodotto la coda immortale (#7587). Gli item che non passano vengono **demoti** — tolti dal corpo, superstiti rinumerati, testo integrale riscritto in un commento sulla PR, esattamente come i `Live-verification` — e la issue viene **soppressa** (chiusa in ingresso) quando non ne resta nessuno. Un corpo senza struttura a item non viene mai soppresso: «non so leggerlo» non è «è vuoto».

Conseguenza pratica per chi conia: un item scritto senza `- Suggested action:` con un token-codice non sopravvive al gate. Scrivi il simbolo, la costante o il path che un `grep` futuro dovrà trovare.

**Seconda strada, dal 2026-09-07 (decisione del proprietario, D3): la scheda con un `COMANDO`.** L'oracolo condiviso è ora una **disgiunzione**, non una congiunzione: un item passa con `Suggested action` + token distintivo **oppure** con una riga di scheda `- METRICA: prima=<n> atteso=<n> | COMANDO: <comando>` il cui comando **nomina un referente** — un file, uno script o un test, cioè un path con una `/` e un'estensione. È lo stesso campo `COMANDO` che `issue-decompose.yml` già emette nel blocco `## Scheda` e che `scripts/audit-canton-url-drift.mjs` emette in forma completa; il gate non conia un vocabolario nuovo, valida quello che esiste. Tre regole che ne discendono, e che il gate applica:

- **Il referente non deve esistere ancora.** Un comando che nomina un test che la PR di fix dovrà scrivere è valido: il costo del nominare si paga alla chiusura, non al conio. Effetto voluto — una issue che si chiude solo quando quel file esiste, per chiudersi ha bisogno di una PR.
- **Una metrica già al bersaglio viene rifiutata.** `prima=N atteso=N` dichiara che non c'è niente da muovere: è irrobustimento travestito da lavoro, ed è la classe che questo gate esiste per non far nascere. Una soglia (`atteso=<N`) non è un bersaglio raggiunto e resta ammessa.
- **Il gate non esegue il comando.** Verifica che ci sia e che nomini un referente, mai che oggi fallisca. Far eseguire i `COMANDO` al gate è una decisione separata e non presa qui.

Il ramo nuovo vive in `hasFalsifiableAcceptance()`, cioè nell'unico simbolo che apertura e chiusura condividono: allargarlo li allarga insieme. Un item ammesso da questa strada non porta token prescritti, quindi `detectAlreadyResolved()` resta `false` su di lui e l'aggregata **non** si auto-chiude — la disgiunzione allarga il conio, non la chiusura.

**Il metro si applica alla tua `Suggested action`, non al bullet grezzo — e il token si DERIVA, non si aspetta.** Sul bullet grezzo `suggestedActionText()` ricade sull'intero testo, quindi i backtick che finiranno in `Original text` fanno sembrare l'item ammissibile; alla chiusura quella regione è esclusa per costruzione e l'item vale `no-valid-item`, cioè è nato già non chiudibile. Misurato eseguendo le funzioni sullo stesso item: `citedTokens()` sul bullet grezzo dà `["manifest.counts"]`, sull'item coniato dà `[]`. Perciò prima formuli l'azione, poi giudichi quella; e se l'item è azionabile ma la frase non porta un token, vai a cercare il file, il simbolo o il campo da toccare e scrivilo (`nomeFunzione()`, `oggetto.campo`, `COSTANTE >= 1` — mai un identificatore nudo né un path nudo, che `isDistinctiveToken()` rifiuta per scelta esplicita). Un item funnel-critico scartato per forma è il caso peggiore: ha codice da cambiare e finisce in un commento che nessun reconciler drena. La rinuncia vale solo quando non c'è niente da toccare.

## Dedup

Tre livelli, in quest'ordine:
- **PR-level**: rileggi i commenti della PR e cerca il marker `## Post-merge follow-up triage` — se esiste, salta quella PR (idempotenza re-run/backfill). Il marker non identifica più un issue per-PR: i finding possono essere già nel bucket giornaliero del repository target.
- **Bucket-level**: per ogni candidate calcola `(daily key, target repository)` e cerca `follow-up(daily:<key>)` nello stesso repository. Se esiste, aggiungi solo gli item nuovi al suo body `collecting`; se non esiste, crea un solo bucket. Se una retry attraversa la mezzanotte e trova un bucket `collecting` storico che contiene una PR della finestra, riusa quella chiave/titolo; una retry non deve creare un secondo bucket per la stessa finestra.
- **Item-level**: fingerprint `target repository + target file + token/azione normalizzata`; un match già presente nel bucket o in una follow-up aperta accorpa la PR nella riga `Sources` e non duplica l'item. Il match titolo/sezione >70% e i riferimenti a issue/PR aperte restano dedup conservativo.
- **In-flight PR overlap** (anti self-flag): se l'item riguarda file specifici (path nel testo / `## Suggested action`), raccogli i file target ed esegui `gh pr list --state open --json number,title` + `gh pr diff <n> --name-only` sulle PR aperte. Se una PR aperta **già modifica** uno di quei file → **escludi l'item** + log "in-flight in PR #N" (un follow-up su un file che un'altra PR sta riscrivendo nasce obsoleto e fa partire il fixer su lavoro in corso; vedi `ISSUES.md → "Pre-condizioni — overlap-file"`). Nel dubbio (item non file-specifico) → non escludere.

Il gate `is-followup-fix-pr.mjs` mantiene la soppressione dei nipoti per le fix PR
normali. Per una fix daily riconoscibile dai due marker (`Addresses` + `Follow-up item`)
emette una deroga limitata: il collector la include soltanto per cercare finding nuovi,
che devono essere deduplicati e aggiunti al bucket padre; non può nascere una nuova
issue per quella PR.

Se dopo il dedup zero item sopravvivono → nessuna issue, summary "zero outstanding items".

## Issue format

**Un solo bucket per giorno e repository target** (non una issue per PR e non una issue
per item). Una PR può contribuire al bucket del sito e, se necessario, a quello del
corpus, ma mai mescolare i due repository nella stessa issue. Il bucket può ricevere
append da più PR e viene lavorato dal fixer un item alla volta.

```markdown
Title: follow-up(daily:<YYYY-MM-DD>): <N> item — <owner/repo>

Body:
## Batch
- Daily key: <YYYY-MM-DD> (Europe/Zurich)
- State: collecting | sealed
- Target repository: <owner/repo>

## Item

### FU-<YYYY-MM-DD>-001 — <one-line item>
- State: open | in-progress | done | blocked
- Sources: PR #<PR_NUMBER>; reviewer 🟡 nit
- Stato dichiarato nella PR: <lo stato letterale verbatim, es. `blocked: <causa>` | nessuno>
- Target file: `path/to/file.mjs`
- Original text:
  > <verbatim>
- Funnel area: <monetizzazione | traffico | UX>
- Suggested action: <next step concreto>
- Acceptance token: `<token-codice-distintivo>`

### FU-<YYYY-MM-DD>-002 — <one-line item>
- State: open
- Sources: PR #<PR_NUMBER>
- Stato dichiarato nella PR: ...
- Target file: `path/to/other.mjs`
- Original text:
  > ...
- Rationale: ...
- Suggested action: ...
- Acceptance token: `otherGuard()`
```

`Stato dichiarato nella PR` è **obbligatorio su ogni item, anche quando è `nessuno`**. È il campo che permette a un agente di distinguere a macchina un residuo che aspetta una decisione umana da uno che potrebbe chiudere subito; senza, l'unico modo è rileggere la PR d'origine a mano, ed è per questo che la coda non si smaltisce. Un item che riporta `nessuno` NON va filtrato via: va aperto lo stesso e sarà il fixer a qualificarlo.

Anche con un solo candidate item il bucket mantiene ID, stato e schema completo. Gli ID
sono assegnati una sola volta e non vengono rinumerati quando un item viene demoto.

Labels: `follow-up`, più UNO tra `funnel-monetization` / `funnel-seo` / `funnel-ux` per ogni funnel-area inferita dall'unione degli item (mix di item → più funnel-* label).

## Closing comment

Dopo aver aggiunto gli item al bucket (o droppato tutti gli item), posta UN commento sulla
PR riepilogativo. Il commento è sempre per-PR, anche quando il bucket è condiviso:

```markdown
## Post-merge follow-up triage

Created/updated: daily bucket #<id> `follow-up(daily:<YYYY-MM-DD>)` con N item:
- <item1 one-line>
- <item2 one-line>

Live-verification (manuale post-deploy, nessuna issue/fixer): Q item
- [ ] "<verbatim>" — <segnale: post-deploy | curl prod | render NNNpx | DevTools/Playwright>

Dropped: M item
- "<verbatim>" — <reason: out-of-scope | dup-of-#X | non-funnel | non-actionable-churn | missing-test-nit>

Skipped: P item (🔴 pre-merge or duplicate active follow-up)
```

La sezione `Live-verification` raccoglie **tutti** gli item `live-verify-only` (vedi `## Filtro scopo → Hard-exclude: live-verification-only item`): checklist `- [ ]` batchata, una sola per PR, **nessuna issue creata e nessun fixer dispatchato** — è solo un promemoria per la verifica manuale dell'owner sul sito deployato. Ometti la sezione se Q=0. Mai promuovere una voce live-verify a issue.

Se zero item sopravvivono al filtro+dedup (e nessuna voce live-verify) → posta `## Post-merge follow-up triage: zero outstanding items.` (nessun bucket creato o aggiornato). Se sopravvivono SOLO voci live-verify (zero issue) → posta il summary con la sola sezione `Live-verification` e la riga `Created: 0 issue (solo live-verification batchata)`.

## Supersede detection → spostata su `followup-reconcile` (deterministica, zero-Claude)

**2026-06-04:** la supersede detection è stata RIMOSSA dal prompt Claude di `post-merge-followup.yml` (il flag su file-touch bruciava turni Claude + `gh issue list --search` per-file a ogni merge, per una segnalazione raramente azionata). Copertura ora di `followup-reconcile.yml` (`scripts/ci/reconcile-followups.mjs`, cron daily, **zero-Claude**): per ogni issue `follow-up` aperta estrae i file/token citati e verifica se la fix è **presente verbatim** nel file.

**2026-06-10 — auto-close a due tier (drena la pila `maybe-resolved` senza perdere qualità).** Il vecchio "la chiusura resta umana" lasciava i `maybe-resolved` a un umano che non arrivava → coda mai convergente (driver #1 del treadmill). Ora `reconcile` chiude in autonomia, ma SOLO con **doppia conferma separata nel tempo** + più veti di sicurezza:

1. **1ª detection** (issue non ancora `maybe-resolved`) → commento advisory + label `maybe-resolved`. **Finestra di grazia**: l'umano ha fino al run successivo per obiettare (rimuovere la label, aggiungere `keep-open`/`pinned`, riaprire lo scope).
2. **2ª conferma** (la issue porta GIÀ `maybe-resolved` da un run precedente, è ANCORA risolta, ha il nostro commento-marker, è un bucket con **tutti** gli item validi `done` — oppure una legacy **single-item** —, **non** ha label keep-open/strategica, e l'evidenza è **forte**) → **auto-close** `--reason completed` + label `fu-resolved-auto`.

Per un bucket giornaliero il veto è item-per-item: body non leggibile, ID mancanti,
stato diverso da `sealed`, acceptance assente, item non `done`, token non confermati o
evidenza debole impediscono la chiusura. Il bucket si chiude solo quando **ogni item
valido** è `done` e la prova supera `isStrongAutoCloseEvidence()`. Un `Closes #N` nel
body di una PR resta vietato per i fix parziali perché GitHub chiuderebbe il bucket
prima degli altri item: usare `Addresses #N` + `Follow-up item: FU-...`. Le label
**keep-open/pinned/revenue/tracker/do-not-close** restano veti umani. Rimozione della
label dopo il flag = **obiezione umana** → il bot tace. La chiusura è reversibile; il
kill-switch `RECONCILE_NO_AUTOCLOSE=1` torna flag-only. Logica pura testata in
`tests/reconcile-followups-decision.test.ts`; matcher condiviso con il pre-flight di
`issue-fix` (`followup-resolution-match.mjs`, AGENTS.md #6).

Gap residuo accettato: un refactor che rende moot un item SENZA aggiungere i token citati non viene flaggato (reconcile cerca i token verbatim). Trade-off scelto per ridurre la spesa Claude per-merge.

## Routing cross-repository

Prima di creare una issue, il follow-up deve risolvere il repository del file che
richiede la modifica comportamentale. Il repository della PR sorgente non è
sufficiente: una PR del sito può contenere un residuo relativo al producer degli
articoli, che dopo il cutover vive nel corpus.

- `nanakokyobashi-rgb/frontaliere-articles`: `generator/**`, `generator/tests/**`,
  `generator/scripts/**`, `content/**`, `data/blog-articles/**`,
  `data/article-source-urls.json`, `data/batch-faq-progress.json` e i workflow del
  corpus che generano o pubblicano articoli. Il twin `scripts/create-article.mjs` va trattato
  come Nanako quando l'item riguarda la generazione live: il producer del sito è
  disattivato.
- `valerielinc-ops/frontaliere-si-o-no`: tutto il resto, compresi deploy, sync,
  validation e mirror che consumano il corpus.

L'issue deve contenere sempre `Target repository:` e `Target file:`. Dedup, label
e commenti devono usare lo stesso repository con `--repo`. Per un target Nanako,
usare il PAT Valerie `GITHUB_PAT` e `gh issue create --repo
nanakokyobashi-rgb/frontaliere-articles`; se il PAT manca, non creare una issue
nel repo Valerie come ripiego: segnalare il blocco sulla PR per il retry successivo.

## Constraint

- Read-only su tutto eccetto: `gh issue create`, `gh pr comment`.
- Mai modificare label/state/title della PR.
- Mai chiudere/riaprire issue.
- Zero finding accettabile (PR LGTM puro senza Non implementato). NON inventare.
- Incerto sul filtro scopo → crea issue comunque, rationale "needs triage". Drop è più costoso di una issue extra.
- Nessun limite che tronchi gli item nel bucket. Se il batch supera il budget della
  sessione, usa chunk seriali e continua ad aggiungere allo stesso bucket; il limite
  vale soltanto per il chunk/sessione e non può perdere i residui.
