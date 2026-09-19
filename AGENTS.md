# Project Agent Instructions

Iniettato in ogni sessione agent. Detail durevole nei docs, carica on-demand.

## Non-Negotiables

1. Mai abbassare quality threshold/test tolerance/validation/SEO gate per passare build. Fix root cause. (NB: il moratorium SEO-landing è stato rimosso/declassato a tracking il 2026-06-24 — non è più un gate; vedi `## Static SEO Pages`.)
   - **Eccezione delimitata, decisa dal proprietario il 2026-08-20: i gate che giudicano il corpus RIASSEMBLATO.** `post-deploy-validate-dist.yml` reidrata l'intero sito pubblicato dagli shard prima di auditarlo, quindi il `dist/` sotto esame **non è l'output di questa build**: contiene pagine emesse mesi fa da codice che non esiste più. Su quella popolazione una soglia a tolleranza zero non è severità, è **un rosso che nessuna modifica al repo può togliere** — `dist/cerca-lavoro-ticino/ricerca-/` è uno slug vuoto che `buildSearchSlug()` oggi non sa produrre e che non compare in nessuno dei cinque file dati dei cluster. Per questi gate — e **solo** per questi — il contratto è **«l'emissione si è rotta?»**, cioè un tasso su un campione che copre il corpus, non la perfezione di ogni pagina storica. Il tasso misurato va **stampato a ogni run**, così la soglia successiva si stringe su un dato invece che su un'intuizione. Restano fuori dall'eccezione, a tolleranza zero: i gate che giudicano ciò che questa build emette (`tests.yml`, `validate-dist-source`), e qualunque invariante di sicurezza o di correttezza del documento servito.
   - Corollario che NON è un rilassamento e non ha bisogno dell'eccezione: se due gate misurano lo stesso invariante e uno dei due sbaglia la misura (regex che pretende gli apici dove il minifier li toglie, popolazioni confrontate che non sono lo stesso insieme, «campione» che è `slice(0, N)` sull'ordine di directory), quello è **un difetto della misura**. Si corregge la misura — non si alza la soglia per assorbire i falsi positivi, e non si abbassa per nasconderli.
   - **Seconda eccezione delimitata, decisa dal proprietario il 2026-08-25 (VISION.md driver D9, issue #5983): un gate SEO "nice-to-have" MIGLIORATO NON si rebaselina/stringe.** Un gate che misura un'euristica di content quality non richiesta da Google come requisito di indicizzazione/ranking (es. text-to-html ratio, profondità BFS — non uno structured-data field mandatory del punto #3 sopra, non un errore di markup, non un 404/redirect rotto) resta com'è quando il valore corrente è **migliore** della baseline committata — `npm run audit:*:rebaseline` NON si esegue in autonomia solo perché il dato è migliorato (lettura iniziale di questa decisione, corretta lo stesso giorno). Il gate diventa **advisory** (report, non `publish`-blocking) invece di venire ottimizzato verso il basso — vedi VISION.md D9 e issue #6462. Restano a tolleranza zero, mai autonomi: gate che verificano dati/markup richiesti da Google, e qualunque REGRESSIONE (`current > baseline`) — quella resta root-cause-first come sopra.
2. Mai downgrade error → warning per sbloccare deploy.
3. Job page structured data DEVE includere in ogni locale: `baseSalary`, `postalCode`, `streetAddress`, `title`, `description`, `datePosted`, `hiringOrganization.name`, `jobLocation`, `employmentType`. Source mancante → safe default, non rimozione check.
4. Mai accettare thin content indicizzato <50 parole.
5. Test fail → trattare test come right finché non provato contrario.
6. Changes chirurgiche: no drive-by refactor, no speculative abstraction, no formatting churn. «Chirurgico» = la *classe* del bug, NON il singolo file. Per fix di pattern (regex/replace/guard/floor/threshold/selector): prima di aprire PR, `grep` dei sibling funnel-critical (`scripts/update-*.mjs`, `build-plugins/**`, `services/seoService.ts`) per lo stesso costrutto → fixa l'intera classe nella STESSA PR (usa `node scripts/ci/check-sibling-patterns.mjs` per automatizzare la grep — euristico, conferma sempre a mano). **Il pre-push hook `.githooks/pre-push` (attivato da `prepare` in `package.json` durante `npm ci/install`) esegue `check-sibling-patterns.mjs` a ogni `git push` ed è ADVISORY dal 2026-09-04 (istruzione diretta del proprietario): elenca i candidati e lascia passare il push. Non serve più `git push --no-verify` per la porta pre-push — leggi l'elenco e ispeziona ciascun file prima di scrivere il body.** L'enforcement resta dove è soddisfacibile: `scripts/ci/sibling-check-gate.mjs` (PreToolUse su `gh pr create`) blocca l'APERTURA della PR finché tutti i candidati surfacati non sono individualmente valutati e documentati come falsi positivi con giustificazione per-file in `## Non implementato` (es. `- scripts/foo.mjs — falso positivo: condivide il token X ma usa Y non Z`); un dismiss collettivo ("tutti falsi positivi") non è sufficiente e il reviewer rifirerà 🔴. **Post-#8 (definizione di «fatto»): elencare un sibling reale in `## Non implementato` NON chiude più il task** — lo tiene aperto finché non è fixato (stessa PR o PR concatenata). L'unica giustificazione che chiude è il **falso positivo**: il costrutto è solo lessicalmente simile ma semanticamente diverso → dichiaralo come tale, non come «posposto». **Stessa disciplina sul RENAME:** rinominato un simbolo/costante/funzione/dominio → `grep` del vecchio nome anche in **commenti, docblock, header di script, titolo PR/commit** nella STESSA PR. Una regex/costante duplicata letteralmente in ≥2 file → estraila in UN modulo condiviso invece di copy-paste, così il drift è impossibile by-construction. Dettaglio/incidenti: `docs/AGENTS-HISTORY.md#sibling-pattern-fix`.
7. Mai disabilitare AdSense Auto Ads (anchor/in-page/vignette). Mai globale, per-route, loader gating, `enable_page_level_ads:false`, meta opt-out. ~95% revenue. CLS/layout fix da Auto Ads → reserve space (`min-height`/`aspect-ratio`/`contain: layout`), pre-declared `<ins>` placeholder fixed dim, image/font width-height fix. MAI sopprimere ad system.
8. **Definizione di «fatto» = completezza totale, NON merge della prima PR.** Un task/funzionalità si ritiene **chiuso SOLO quando `## Non implementato (ancora)` legge «Nessuno»** — cioè quando *tutto* lo scope elencato è implementato e **live**, inclusi gli item che prima si etichettavano `out of scope` / `posposto` / `follow-up`. Il deferral come meccanismo di chiusura è **ABOLITO**: `## Non implementato` non è più un permesso di fermarsi, è un **piano di completamento tracciato** che tiene il task **APERTO**. Finché contiene scope reale, l'agente **PROSEGUE** (stessa PR quando possibile — vedi single-bundle — o PR concatenate sullo stesso task) fino a portarlo live; non chiude il turno dichiarando «fatto» con residuo aperto. «Out of scope» NON è più una scappatoia: se un lavoro è correlato/necessario va fatto; se è davvero un task diverso e scorrelato **non va elencato qui** (apri un task separato), ma se lo elenchi ti impegna. I CINQUE stati letterali chiudenti sono quelli di `CLOSING_STATES` in `scripts/ci/followup-has-candidates.mjs`: `in questa PR`, `PR concatenata #N`, `blocked: decisione del proprietario`, `per scelta`, `by construction`. `per scelta` e `by construction` sono un **no motivato**, non un rinvio — chiudono la voce **SOLO col motivo scritto** dopo lo stato; senza motivo = 🔴. `blocked: <causa tecnica>` è lavoro esterno sospeso: l'agente tenta di **rimuovere il blocco** — vedi `## Build And Test → Blocker ≠ stallo` — e se è impossibile il task resta **non chiuso**. Reviewer: scope-feature residuo senza essere fatto né piano di completamento, o stato motivato senza motivo = 🔴 (vedi `REVIEW.md`).

## Privacy

- Git identity canonica: `Valerie Linc <valerielinc@gmail.com>`. Mai altre identità.
- Pre-commit PII scan vs `.git/info/pii-blocklist.txt` (untracked, per-clone). Mancante → prompt user.
  - Scan: `git diff --cached | grep -niE -f .git/info/pii-blocklist.txt` + same per commit-msg file.
  - Match → abort + chiedi sanitize.
- Strip `Co-authored-by:` con email non canonica.
- Mai committare absolute home `/Users/<anyone>/...`. Usa relative, `$HOME`, `~`, `git rev-parse --show-toplevel`, env.
- Mai hard-code personal email in code/config/data. Usa env (`process.env.*`) o canonical.
- Stringa in diff dubbia → chiedi user.

## Workflow

- Worktree-first obbligatorio per task che edita/committa/pusha. Local `main` checkout = shared/read-only (status/inspection).
- **Base worktree = `origin/main`, MAI il local `main` checkout.** Fai `git fetch origin main`, poi `git worktree add -b <branch> <path> origin/main`; il local `main` sporco è intoccabile. Verità: `git show origin/main:<file>`. Sync locale stale/dirty solo su richiesta esplicita user: `docs/LOCAL-DEV.md#syncing-a-stale-dirty-local-main-explicit-user-request-only`.
- Mai edit/stage/stash/restore/commit/rebase/merge sul local `main` salvo richiesta esplicita user. File dirty = foreign work intoccabile; non branchare da lì.
- Parallel/subagent → sempre worktree isolati, mai shared dir.
- Auto commit+push task successful. PR-as-merge-vehicle: create PR, squash merge, delete remote branch, remove worktree.
- `delete_branch_on_merge: true` (2026-05-29): GitHub cancella il branch remoto a ogni merge; `worktree-branch-janitor.yml` copre le chiusure senza merge. Dopo il merge rimuovi branch locale + worktree; audit: `git branch -r` deve mostrare solo `main` e PR aperte. Dettaglio: `docs/AGENTS-HISTORY.md#branch-cleanup`.
- PR body OBBLIGATORIO con `## Implementato` + `## Non implementato (ancora)`; vedi `REVIEW.md`. La seconda sezione è il piano di completamento ancora aperto (Non-Negotiable #8), non un rinvio: ogni bullet ha stato/next step letterale e il task è completo solo con «Nessuno». Verifica il body contro `git diff origin/main` prima di `gh pr create`; dettaglio: `docs/AGENTS-HISTORY.md#pr-body-contract`.
- Se la PR rende **moot/obsoleta** una issue aperta → dichiaralo nel body: `Closes #N` (chiude al merge) o `Supersedes #N` (link, non chiude). Solo `Closes #N` esplicito chiude — niente issue orfane.
  - **Due meccanismi distinti.** `closingIssuesReferences` (`gh pr view <N> --json closingIssuesReferences`) è l'anteprima del body, non l'azione reale. La chiusura vera legge `squash_merge_commit_message` (`gh api repos/<owner>/<repo> --jq '.squash_merge_commit_message'`) dai commit, non dal body: una keyword solo nel body può non bastare. Prima di dichiarare completo verifica `closingIssuesReferences`; dettaglio: `docs/AGENTS-HISTORY.md#closes-must-be-in-pr-body`.
  - **MAI** scrivere `Closes`/`Fixes`/`Resolves`+`#N` in un commit message adiacente a un'issue reale, nemmeno come narrativa storica — finisce nel commit di merge e GitHub la esegue alla lettera. Riferimento storico a un'issue: numero senza `#` (es. "issue 3485"), mai adiacente a keyword di chiusura.
  - **Multi-issue: una keyword per issue, una per riga** — `Closes #a #b #c` chiude solo `#a`. Scrivi `Closes #a` / `Closes #b` su righe separate. Gate `pr-body-contract.yml` + reviewer flaggano la violazione. Dettaglio: `docs/AGENTS-HISTORY.md#multi-issue-close`.
- PR pronta per `main` → il workflow required `.github/workflows/tests.yml` esegue source gates, typecheck, test correlati/Vitest, review Codex Luna Max e lo step `Require approving Codex review` nello stesso job `vitest (unit + integration)`. Quando il gate approva la HEAD corrente, il job può invocare `scripts/ci/pr-autorebase.mjs`: il percorso normale è riservato alle PR near-merge con review approvata; il percorso di stale rescue richiede invece `stale-review` e che la catena di review sia conclusa con il solo review gate in errore. L'helper resta bounded: riusa un verdetto solo quando il gate ne conferma provenienza e HEAD esatta; un rebase che crea una nuova HEAD richiede la verifica della nuova HEAD. Riattiva/ri-verifica test e review tramite rebase/reopen o dispatch di recovery quando il codice lo ammette. Solo dopo il job verde e la validazione della sorgente trusted da `main` abilita il native auto-merge di GitHub; `retry-native-automerge.yml` è il fallback schedulato bounded quando l'opt-in in-job fallisce o manca il token App. **NIENTE merge manuale, mai:** dalla root workspace attendi `MERGED`, verifica il risultato e poi fai cleanup di worktree e branch locale. `🔴 Important` o un review gate senza approvazione mantiene la PR ferma.
- **Attesa PR = osservazione event-driven.** Dalla root workspace (`~/Projects/frontaliere`), registra una subscription con `bin/gh-frontaliere events subscribe --repo valerielinc-ops/frontaliere-si-o-no --resource pull_request --number <N> --wait-for merged,failed --agent-id <id>` e avvia un solo `bin/gh-frontaliere events listen <subscription-id>`; non usare polling di `gh pr view`, `gh run view` o `gh pr checks`. Se la subscription scade, tratta l'esito come `timed-out` e dichiara la prossima azione; a `MERGED` verifica il risultato prima del cleanup. Dettaglio: `docs/AGENTS-HISTORY.md#active-pr-watch`.
- **Diagnosi conflitti:** `mergeable` è asincrono e può restare `UNKNOWN`; misura con `git fetch origin main && git merge-tree --write-tree origin/main HEAD` (exit 1 = conflitto, righe `<mode> <oid> <stage>\t<path>` = file). `pr-autorebase.mjs` applica label/commento e li rimuove quando il conflitto rientra.
- **MAI `git merge origin/main` per profilassi.** Ogni merge crea un nuovo head, invalida il giro CI in corso e ne costa un altro (mediana ~13 min, p90 ~21 min): misurato il 2026-09-17, 168 merge di `main` su 203 erano puliti e senza drift, cioè puro costo. Essere dietro `main` **non** è un motivo: `tests.yml` gira sul merge ref (`refs/pull/N/merge`), quindi il workflow eseguito e la suite vitest contengono già `main` (`scripts/ci/lib/vitestCheck.mjs`). Mergi `main` in un solo caso: `git merge-tree --write-tree origin/main HEAD` esce 1, cioè conflitto reale. Rosso ereditato da `main` → non mergiare, basta un nuovo giro sullo stesso head (`pr-autorebase.mjs` lo fa con close+reopen). Il `401 Unauthorized — Workflow validation failed` **non è più raggiungibile sul sito**: veniva dall'OIDC di `anthropics/claude-code-action`, fuori dal percorso di review dal 2026-09-10 (#8200). Se una PR modifica un file di `REVIEW_WORKFLOW_DRIFT_FILES` (`scripts/ci/lib/constants.mjs`), il merge non toglierebbe comunque la modifica: la copre il drift-fallback di `scripts/ci/auto-merge-eval.mjs`. Storia: `docs/AGENTS-HISTORY.md#workflow-validation-drift`.
- Post-merge check/deploy fail → mai fix diretto su `main`; nuovo worktree+branch, fix root cause, nuova PR, merge, riosserva `main`.
- Pre-task-close: audit worktree/branch. PR merged → delete remote branch + remove worktree immediato. Not merged → lascia + dichiara decisione merge/abandon esplicita.
- **Leak locale worktree/branch:** pre-task-close DEVE eseguire `node scripts/prune-merged-worktrees.mjs` in dry-run e poi `--apply`; gli hook `.claude/settings.json` fanno `SessionEnd --apply --orphans-only` e `SessionStart --apply`. `fix/issue-N` con issue chiusa viene rimosso senza PR; lo script tocca SOLO `.claude/worktrees`/`.worktrees`; `worktree-branch-janitor.yml` copre il remoto. Dettaglio: `docs/AGENTS-HISTORY.md#worktree-branch-leak`.
- **`git push` lento o con pack enorme** indica manutenzione del clone, non rete: `docs/LOCAL-DEV.md#git-push-timeout--huge-pack-for-a-tiny-diff`.
- **Worktree agent = sparse checkout, non checkout intero.** Usa `docs/LOCAL-DEV.md#sparse-worktrees-for-agent--multiagent-sessions`; mai `--depth`/`--filter` come alternativa, perché rompono il push. Costi: `docs/REPO-WEIGHT-STRATEGY.md`.
- **Hook/script che fa rete:** lock single-flight e timeout obbligatori; riusa `scripts/lib/single-flight-lock.mjs` (come `prune-merged-worktrees.mjs`). Dettaglio: `docs/AGENTS-HISTORY.md#hook-fetch-pileup`.
- **`git push` su clone/checkout SHALLOW:** usa `git -c pack.window=0 -c pack.threads=1 push --no-thin origin <branch>`, non thin-pack. Runbook: `docs/LOCAL-DEV.md#git-push-hangs-on-a-shallow-clone-thin-pack-delta-search`; dettaglio: `docs/AGENTS-HISTORY.md#shallow-clone-thin-pack`.
- GitHub operations: `gh` CLI only.
- Mai `send-newsletter.mjs --send` locale. Usa `--preview` o `--test --target-email <email>`.
- Nuovi workflow Actions → run live su `main` post-merge: `gh workflow run <workflow>.yml --ref main`.
- E2E: Playwright CLI o Codex Browser. No preview-only tools.
- Playwright MCP (`browser_*`): artifact in `$CLAUDE_JOB_DIR/tmp` o worktree root — mai `/tmp` né `file://` (servi via http); prima di `browser_click`/`browser_evaluate` su pagina dinamica → `browser_snapshot` fresco; `--isolated` evita lock.
- Mai full build locale; trigger/validate via GitHub Actions.

## Post-merge feedback handling

- Reviewer bot posta 🔴/🟡/❓ in review body. **Mai silent ignore di 🟡/❓.** Workflow `post-merge-followup.yml` triagia automaticamente post-merge: legge PR body `## Non implementato` + reviewer 🟡/❓/adversarial-check, applica filtro scopo (`REVIEW.md`), crea issue `follow-up` + summary commento sulla PR. Contratto in `FOLLOWUP.md`.
- 🔴 Important blocca merge (auto-merge richiede `## LGTM`). Se compare 🔴 → fix in nuovo commit sullo stesso branch, re-review automatica.
- Agent inizio task DEVE controllare `gh issue list --label follow-up --state open` se tocca area correlata. Issue follow-up esistente per scope corrente → linkare nel PR body (`## Implementato` chiude issue con `Closes #N`) o aggiornare l'issue con rationale.
- Test plan PR body con `- [ ]` non spuntate post-merge → spunta dopo verifica live, oppure converti in issue follow-up. Reviewer flagga come 🟡 quelle non verificabili pre-merge (vedi `REVIEW.md → "Test plan compliance"`).
- Eccezione drop senza issue: nit puro stilistico-deferibile (non funnel) → reply inline sulla PR review thread con motivo "deferred — non funnel-critical". `post-merge-followup.yml` lo include automaticamente nella sezione "Dropped" del summary.

## Auth automazioni & frugalità quota

- **Auth Codex Luna Max = SOLO `CODEX_AUTH_JSON`** (subscription, zero costo API) per i workflow agentici `tests`, `issue-fix` e `post-merge-followup`; il wrapper locale `claude-codex-fallback` inoltra la sessione al broker Codex, ma questi percorsi usano Codex Luna Max e non un provider Claude/Anthropic di fallback. **Mai aggiungere `ANTHROPIC_API_KEY` o `CLAUDE_CODE_OAUTH_TOKEN`** ai workflow agentici.
  - **Eccezione scoped (owner-approved 2026-07-28, issue #4495)**: `functions/src/claudeHaikuFallback.js` legge `ANTHROPIC_API_KEY` da Remote Config come ultimo rung, a pagamento, delle fallback chain di `geminiGenerate.js`/`chatbotInference.js` — DOPO Gemini e tutti gli OpenAI-compatible free (Groq/NVIDIA). Sono Cloud Functions stateless in produzione, non workflow agentici; questa chiamata diretta Haiku resta quindi separata dalla migrazione Codex. Provisioning del valore reale del secret in Remote Config resta owner-only (nessun template Remote Config è checked-in nel repo).
- **Quota condivisa**: la subscription Codex Luna Max è condivisa fra le run CI e la sessione interattiva owner. Burst di run CI → session limit esaurito anche nell'uso interattivo. Frugalità = ridurre il **numero di invocazioni Codex**, per **architettura** non tagliando turni.
- Leve frugalità attive:
  - **`issue-triage` = ZERO agente** (shell deterministico + helper Node `scripts/lib/classify-issue.mjs`) → eliminati ~50 run/giorno, il driver principale del session-limit.
  - **Dedup a monte**: titolo stabile per validation-failure (`github-issue-creator.mjs` commenta 🔁 sull'issue canonica, 8→1) + follow-up batchati in 1 issue aggregata/PR (#925) → meno issue → meno trigger `issue-fix`.
  - Concurrency per-issue (`cancel-in-progress: false`) con cap bounded a 7 fixer remoti; routing salta le issue non-OPEN e i claim locali/remoti.
  - **Mai** abbassare max-turns di `tests`/`issue-fix`/`post-merge-followup`: turni bassi troncano prima degli step obbligatori → `error_max_turns` (PR #838). Lever su turni = claim non misurato (#795/#802 revertati).

## Issue automation (loop autonomo)

- Pipeline: monitor → issue → `issue-triage` (classify+route **deterministico, zero agente**; App GitHub primaria con fallback PAT da Remote Config) → `issue-fix` (Codex Luna Max: fix→PR) → required `tests.yml` (gate, test e review Codex sulla stessa HEAD) → native auto-merge GitHub → deploy → `post-merge-followup` (Codex Luna Max, batch schedulato). Contratto completo in `ISSUES.md` / `FOLLOWUP.md`.
- **Il routing non abilita ogni categoria in modo indiscriminato.** La classificazione passa prima dalla policy F1/F7: sull'issue surface domini ad alto rischio, control-plane, path ignoti, metadata non verificabili e issue sconosciute sono deny-by-default e ricevono `needs-human`; una PR con metadata e file-list completi può conservare quei segnali come evidenza, ma `needs-human` lì è solo tracking. Se la policy consente l'automazione, `crawler` → `agent:fix` diretto (uno per run/slot libero, eccedenza in coda); `follow-up`, `validation-failure` e `tracker` → `agent:fix-queued`; `other` passa solo con segnali ordinari espliciti (oggi le label locale note), non come catch-all automatico.
- **Claim mutex `agent:in-progress`** (#4788/#4793): dopo la risk policy, quota/preflight, `issue-fix.yml` reclama il claim prima di tier e provider; la concorrenza per issue è `cancel-in-progress: false` e il drainer mantiene un pool bounded. Chi arriva prima vince, l'altro salta senza spendere turni; errori GitHub/API/parse sono fail-closed. Il release remoto è gated su `claim_acquired=true` e rimuove il mutex `agent:in-progress` insieme a `agent:remote` solo quando quel run ne è il proprietario; il detector stale può recuperare claim remoti/legacy senza PR, proteggendo quelli locali.
- **Dedup a MONTE, non nel triage**: i monitor non devono aprire issue duplicate. Usa `scripts/lib/github-issue-creator.mjs` con **titolo stabile** (no run-number/timestamp nei primi 60 char) → dedupa e commenta sull'issue canonica. I follow-up: 1 issue aggregata/PR (`post-merge-followup` / `FOLLOWUP.md`, #925).
- **Handoff triage→fix richiede App token o PAT**: il triage usa l'installation token App come identità primaria e `GITHUB_PAT` come fallback; una label `agent:fix` via `GITHUB_TOKEN` NON triggera `issue-fix` (anti-ricorsione GitHub) e ha sender `github-actions[bot]` che non passa il gate. `GITHUB_TOKEN` resta per label anti-loop (`agent:triaged`) e per l'escalation `needs-human`. I workflow che devono triggerarne altri caricano il PAT via `scripts/load-rc-env.mjs` (serve Firebase SA).

## Build And Test

```bash
npm run dev
npm run build
npm test
```

Agent sessions ereditano `FAST_BUILD=1`; override per validare SEO plugin output:

```bash
FAST_BUILD= npx vite build
```

Full local SEO builds OOM. Usa remote CI o audit replay; no full local SEO build salvo richiesta esplicita user. Audit replay dist-only:

```bash
gh workflow run audit-dist-from-run.yml -f deploy_run_id=<run_id> -f audits=<audit-list>
```

CI required job `tests.yml` (`vitest (unit + integration)`): `npm ci`, source guards, `node scripts/assemble-jobs-dataset.mjs --stats`, `node scripts/migrate-all-known-job-slugs-canton-aware.mjs`, test correlati/Vitest e, per le PR, review Codex Luna Max + `Require approving Codex review`, tutto sulla stessa HEAD.

- **Required check unico**: `tests.yml` si attiva sull'evento `pull_request` e mantiene test e review nello stesso job; la review non è un workflow successivo e non è un prerequisito per aprire la PR. Il gate deve però concludere con approvazione Codex sulla HEAD esatta prima dell'opt-in al native auto-merge. Il provider agentico usa `CODEX_AUTH_JSON`; non assumere un fallback Claude/Anthropic.
- **Pre-PR si girano i test IMPATTATI dal diff, non la suite intera** — `scripts/ci/run-related-tests.mjs` seleziona il grafo statico dalla root del worktree:
  ```bash
  git fetch origin main -q
  base="$(git merge-base origin/main HEAD 2>/dev/null || true)"
  if [ -n "$base" ] && git diff --name-only "$base" > changed-paths.txt; then
    git ls-files --others --exclude-standard >> changed-paths.txt
    sort -u -o changed-paths.txt changed-paths.txt
    printf 'complete\n' > changed-paths-status.txt
  else
    : > changed-paths.txt
    printf 'partial\n' > changed-paths-status.txt
    echo '⚠️ merge-base con origin/main non risolto → nessuna selezione affidabile, suite intera'
  fi
  node scripts/ci/run-related-tests.mjs
  ```
-  `changed-paths.txt` è input del runner: `complete` solo con merge-base e `git diff` riusciti, `partial` → suite intera. Il ref va usato **senza punti** per includere anche untracked; controlla l'elenco. `N tracked file(s) unreadable …` da symlink esclusi nello sparse è atteso salvo crescita anomala. Dettaglio: `docs/AGENTS-HISTORY.md#test-verdi-gate`.
- **La suite intera NON è l'oracolo pre-PR in uno sparse worktree.** Usala (`node scripts/assemble-jobs-dataset.mjs && npm test`, con `onnxruntime-node`) solo per copertura completa e confrontala con `origin/main`; `public/`/`data/` assenti possono causare rossi ereditati.
- **Un test non scrive MAI in un file tracciato.** Redirigi in `os.tmpdir()` e parametrizza il path via env (modello `GSC_ORPHAN_CLUSTERS_OUT`); il cron mantiene il path canonico.
- **I file gestiti dai cron NON si committano né si pushano da locale.** Elenco in `scripts/dev/local-ignore-cron.sh`; controlla `git status` prima di `git add -A`, togli quei path dallo stage: `--skip-worktree` non si eredita nei worktree.
- **Test fixture: mai date assolute.** Usa `daysAgo(n)` per `crawledAt`/`datePosted`; dettaglio: `docs/AGENTS-HISTORY.md#test-fixture-relative-dates`.
- **main rosso blocca a cascata:** se vitest è rosso su `main`, fixa la root cause prima di altro lavoro pipeline.
- **Blocker ≠ stallo: rimuovi il blocco.** Cerca fix esistenti, misura il costo e conferma il dominio prima di `fuori scope`; lo scope residuo resta aperto secondo Non-Negotiable #8. Dettaglio: `docs/AGENTS-HISTORY.md#blocker-not-stall`.
- **Data-refresh che committa su `main` = stesso gate test di una PR.** Valida l'invariante prima del commit, non committare dump grezzi e mantieni un cap ragionevole; dettaglio: `docs/AGENTS-HISTORY.md#data-refresh-gate`.
- **Claim build/perf/memoria non validabile pre-merge:** allega un run misurato oppure dichiara il trigger di revert in `## Non implementato`; dettaglio: `docs/AGENTS-HISTORY.md#unvalidated-perf-claim`.

## Architecture

- React 19 + TypeScript + Vite + Tailwind.
- No React Router. Routing hand-rolled in `services/router.ts`; `App.tsx` owns navigation state.
- Canonical prod domain: `https://frontaliereticino.ch` (no `www`).
- **Trailing slash obbligatorio su OGNI nuovo link/route/URL.** Convenzione canonica del sito: `buildPath()` (`finish()` in `services/router.ts`) e `joinPath()` (`build-plugins/weeklyEmployersData.ts`) lo forzano già; canonical/sitemap/og:url lo usano; la zone redirect rule `trailing-slash-301` (gestita da `scripts/cf-locale-failover-setup.mjs`, #3472) 301-redirecta no-slash→slash all'edge. Mai hardcodare URL senza slash finale (es. in email/CF/script/`trackPageView`) — preferisci `buildPath({activeTab:...}, locale)` invece di stringhe a mano (slash by-construction). Un href/URL letterale senza slash = doppione non-canonico. Pre-PR: grep dei nuovi `href=`/URL string nel diff → verifica lo slash.
- Primary locale Italian; EN/DE/FR via chunked locale files in `services/locales/`.
- Nav caps: 6 top-level tabs, 8 sub-tabs/category.

## Static SEO Pages

- Static SSG page emit via build plugin DEVE usare `build-plugins/shared/seoPageShell.ts` → `buildSeoPageHtml`.
- Static plugin contract: `apply: 'build'`, `enforce: 'post'`, emit in `closeBundle()`, pass `distDir`.
- **Ogni loop SSG canton-scoped con floor/soglia** (`continue` su below-floor/zero-match) DEVE, STESSA PR: (1) emettere bridge page `noindex,follow` alla stessa URL invece di skip silenzioso (pattern `renderBelowFloorBridge`/`emitEditorialBelowFloorBridge`/`emitCantonHubBelowFloorBridge`, PR #3594); (2) aggiungere self-map in `build-plugins/searchConsoleCompat.ts:resolveSearchConsoleCompatTarget` (modello `isProfessionCantonPath`) — altrimenti uno snapshot 404 GSC resta non-risolvibile anche a pagina live. Nuovo self-map → precompila slug in `Set` a module-load (mai ricostruire Set per-chiamata nel loop: rompe `tests/search-console-compat.test.ts` su 150k+ path). Gate deterministico (`scripts/ci/check-below-floor-bridge.mjs`, ADVISORY in `pr-body-contract.yml`, euristico regex non AST — candidato ≠ verdetto). Dettaglio: `docs/AGENTS-HISTORY.md#below-floor-bridge-self-map`.
- Body styling HTML statico: Tailwind utilities only. `tailwind.config.js` content DEVE includere `./build-plugins/**/*.{js,ts}`.
- SPA/static handoff = router-driven via `staticOverlay`; mai reintrodurre DOM heuristic per `main.seo-static-content`.
- Mobile-first: real content subito dopo H1/tagline. Long intro/methodology/FAQ sotto action/data area o in accordion collassati.
- SEO landing order: breadcrumb, header con one-line lede ≤120 chars, 3-5 stat tile, advice banner se utile, primary CTA, data area, prose lunga.
- Solo semantic color token esistenti; no inline hex.
- Crawler dedicati: merge job by stable id `extractStableJobId(job.url)`, preserva previous slug, truncate via `truncateSlugAtWordBoundary`.
- SEO landing moratorium **RIMOSSO** (owner 2026-06-24): nuove SEO landing consentite. Posizione media 7-day GSC (`data/gsc-position-rolling.json`) resta tracciata ma solo informativa — `scripts/check-seo-moratorium.mjs` report-only, step CI `continue-on-error`. NON re-introdurre gate bloccante sulla posizione senza richiesta esplicita owner. Dettaglio/incidente: `docs/AGENTS-HISTORY.md#seo-moratorium-removed`.

## Accessibility And UX

- Nuova pagina richiede: SEO metadata, sitemap coverage, accessibility check, translated key in tutti 4 locali (se user-facing text).
- Contrast min: 4.5:1 normal, 3:1 large.
- Mai `text-slate-400` su bg chiari.
- Button → accessible name. Image → `width`, `height`, `alt`.
- No `dark:` color class salvo `dark:prose-invert`; usa semantic token in `index.css`.
- User-facing feature → entry in `WhatsNewModal.tsx`.

## Reference Docs

CI/CD `docs/CI-CD-PIPELINE.md` · Article learning loop `docs/ARTICLE-LEARNING-LOOP.md` · SEO rules `docs/SEO-RULES.md` · SEO gates `docs/SEO-GATES.md` · Information Gain `docs/INFORMATION-GAIN.md` · CWV field criterion (#5001) `docs/CWV-FIELD-CRITERION.md` · SEO features `docs/SEO-FEATURES.md` · Crawlers `docs/CRAWLERS.md` · Cathedral plan `docs/CATHEDRAL-IMPLEMENTATION-PLAN.md` · Rollback `docs/CATHEDRAL-ROLLBACK.md` · Design `docs/DESIGN-CONTEXT.md` · Local dev `docs/LOCAL-DEV.md` · Repo weight/agent cost `docs/REPO-WEIGHT-STRATEGY.md` · Cloud sessions (web/mobile) `docs/CLOUD-SESSIONS.md` · Agent-rule incident history `docs/AGENTS-HISTORY.md` · Editorial longform audit `docs/editorial-longform-audit.md` · Ads placement per longform `docs/ads-placement-longform.md` · Content brief pilota Insubria `docs/citta-dei-laghi-content-brief.md`
