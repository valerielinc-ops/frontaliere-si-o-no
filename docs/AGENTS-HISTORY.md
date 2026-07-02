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
