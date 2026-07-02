# AGENTS.md — Incident History & Rationale

Extracted from `AGENTS.md` to reduce context window usage (same pattern as `docs/CI-CD-PIPELINE.md`). `AGENTS.md` keeps the operative rule; this file keeps the incident narrative, citations, and root-cause detail behind each rule. Not injected into every agent session — load on demand.

## sibling-pattern-fix

Pre-empt del 🔴 reviewer "stesso antipattern nel file gemello" (bucket `sibling-class-fix` ×7 in 14gg, #1348) → risparmia un ciclo review+fix (~3M token quota Max). Un commento o un titolo che descrive ancora il meccanismo vecchio dopo un rename = 🟡 stale ricorrente (6 PR cluster CDN #1185–1311: jsDelivr→cdn-domain, orphan-branch→Pages).

## branch-cleanup

Repo setting `delete_branch_on_merge: true` attivo dal 2026-05-29. Prima di allora, PR `CLOSED` non-merged lasciava il ref remoto orfano; ora chiuso dal trigger `pull_request: [closed]` in `worktree-branch-janitor.yml` (job `delete-closed-unmerged`) che cancella subito il head ref di una PR chiusa-non-mergiata (skip fork/protected); il cron resta rete di sicurezza (≤24h).

## pr-body-contract

`pr-body-contract.yml` valida solo la presenza degli header, non il contenuto. Un `## Implementato` che afferma "Nessun sibling da sweepare" quando il diff mostra sibling cambiati = 🟡 reviewer-finding (cluster PR #1508, bucket `pr-body-contract`, 8 occorrenze 14gg).

## multi-issue-close

GitHub chiude SOLO la prima issue dopo una keyword di chiusura (`Closes`/`Fixes`/`Resolves`). Osservato su PR #1320: 9 issue elencate su una riga → solo 1 chiusa, 8 rimaste aperte.

## lgtm-automerge

L'unico file che fa driftare il reviewer è `.github/workflows/pr-review-loop.yml`: la GitHub App esige il workflow byte-identico a `main` → 401 → niente `## LGTM`. Le PR che lo modificano ora auto-mergiano via il drift-fallback deterministico in `scripts/ci/auto-merge-eval.mjs`. Gli altri file storicamente citati come a rischio drift (`auto-merge-on-lgtm.yml`, `post-merge-followup.yml`, `REVIEW.md`, `FOLLOWUP.md`) NON driftano — review + `## LGTM` normali per quelli.

## active-pr-watch

Causa #1 osservata di "agent addormentato": PR #2000 — 42min senza check dopo `gh pr create`; PR #1031 — poller silenzioso da 30min. L'harness non traccia eventi GitHub Actions/Cloudflare (merge/review), quindi un agent che chiude il turno dopo il push resta fermo finché l'utente non lo nudga. Vedi anche memoria `active_pr_watch` / `no_idle_waiting_on_external_ci`.

## workflow-validation-drift

Sintomo osservato: `App token exchange failed: 401 Unauthorized — Workflow validation failed. The workflow file must have identical content to the version on the default branch`, body review vuoto, nessun `## LGTM`. Diagnosi errata comune: sembra un problema di auth (l'`anthropic_api_key: ""` vuoto nei log è un falso indizio — l'auth reale è via `secrets.CLAUDE_CODE_OAUTH_TOKEN`, ottenuta correttamente) o un problema che un re-run risolve (non lo risolve, il branch resta disallineato finché non fai merge).

## worktree-branch-leak

Osservato 2026-06-03: 7 worktree + 38 branch locali, 33 orfani. Il cleanup ancorato all'evento-merge nel turn dell'agent non copriva tre buchi:

- (a) **EnterWorktree** auto-rimuove la *dir* worktree se unchanged ma lascia il branch `worktree-agent-<id>` orfano (0-ahead).
- (b) **squash-merge**: GitHub auto-cancella il remoto (`delete_branch_on_merge`) ma il branch **locale** resta e `git branch --merged` lo vede *unmerged* (lo squash riscrive la history) → mai potato dai comandi standard.
- (c) **sessione morta/timeout**: l'agent non raggiunge mai il pre-task-close.

Senza consultazione issue-state, EC1 (branch `fix/issue-N` senza PR) risparmiava per sempre i branch orfani la cui issue era già chiusa: `fix/issue-1183`/`1189`/`1497` restarono bloccati ~12 giorni prima del fix.

I worktree **Codex** (fuori dagli hook Claude) e i branch con remoto già cancellato restano **report-only** con flag `upstream-GONE` — mai auto-delete su quel caso, per non distruggere lavoro potenzialmente vivo.

## git-repo-maintenance

Issue #3276: `git push` timeoutava/killava su un branch nuovo di **un singolo file YAML** (`git rev-list --objects origin/main..HEAD` → 5 oggetti necessari), ma il push reale tentava di POSTare **258MB / 35'722 oggetti** (`RPC failed; curl 28 Operation too slow` → `unexpected disconnect while reading sideband packet`). Un `tee`-wrapped background push aveva anche mascherato l'exit code reale (0 di `tee`, non di `git`) facendo sembrare il push riuscito quando in realtà il branch remoto non esisteva (`404 Branch not found`).

Diagnosi: `.git` locale a **5.8GB**, 47 pack file, 1.96M oggetti in-pack, `prune-packable: 509` — nessuna manutenzione (`git gc`/repack) mai girata nonostante il volume di commit bot giornalieri. `git multi-pack-index write --bitmap` falliva con `Packfile doesn't have full closure (object ... is missing)`: uno dei 47 pack conteneva un delta (`REF_DELTA`) il cui oggetto base viveva in un ALTRO pack — un pack "non chiuso". `git cat-file --batch-check` risolveva comunque l'oggetto (lookup aggregato su tutti i pack, trasparente per operazioni normali come `log`/`checkout`), ma per `pack-objects` nel calcolo del boundary di un push questo rompe la negoziazione thin-pack: invece di inviare solo i delta minimi, il calcolo fallback include catene di delta ridondanti, gonfiando il pack da pochi KB a centinaia di MB. Root cause: repo senza `git repack -a -d` periodico, che accumula pack disgiunti con riferimenti cross-pack nel tempo.

Trovato in corso anche un file `refs/.DS_Store` (metadata macOS finita dentro `.git/refs/`, probabilmente da una navigazione Finder con "mostra file nascosti") che `git fsck` segnalava come `badRefName`/`badRefContent` — non la causa del push, ma corruzione concorrente da ripulire.

Fix: rimosso `.git/refs/.DS_Store`; `git repack -a -d -b` (consolidamento full + bitmap, richiede headroom disco ~2× la dimensione del pack corrente); `git maintenance start` per manutenzione incrementale schedulata (gc/repack/commit-graph/prefetch via launchd) così i pack non si ri-accumulano tra una sessione e l'altra.

Concausa disco: al momento del fix il disco era al 98% (12GB liberi) per un leak di ~20 directory worktree orfane sotto `.claude/worktrees/` (non registrate in `git worktree list`, zero processi attivi via `lsof`, alcune risalenti al 17 giugno) — probabile buco (d) del pattern `worktree-branch-leak` sopra, ma a livello di **filesystem** invece che di `git worktree`/branch: una directory rimasta orfana quando l'operazione di rimozione worktree non è arrivata a completamento. Rimosse dopo verifica incrociata `git worktree list` (assenti) + `lsof +D` (nessun processo con cwd lì) per non toccare worktree di sessioni parallele realmente attive.

Riferimento: repack `-a -d -b` è costoso (CPU/tempo proporzionali al numero di oggetti, ~1.96M in questo caso) e richiede headroom disco per il pack temporaneo mentre i vecchi pack restano validi fino allo swap finale — non lanciarlo con <2× la `size-pack` corrente di margine libero.
