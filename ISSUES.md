# Issue Automation Instructions

Contratto operativo per la pipeline issue-agent: `issue-triage.yml` (classify + dedup) e `issue-fix.yml` (fix → PR). Companion locale: `/fix-issue N` (`.claude/commands/fix-issue.md`).

## Scopo

Le issue di questo repo sono per lo più **auto-generate dai monitor** (post-deploy validate dist/live, crawler-health, rpm-canary, follow-up post-merge). Vanno instradate per categoria, non trattate da un singolo agent indistinto. Obiettivo: ridurre il rumore (dedup storm) + risolvere autonomamente le categorie deterministiche, lasciando alla mano umana solo lo strategico.

## Categorie

| Categoria | Segnale (titolo/label) | Natura |
|---|---|---|
| `validation-failure` | "Validation Failure (dist\|live)", label `bug`+`priority:urgent` | alert post-deploy, spesso dupe/transiente |
| `crawler` | "Crawler Failure", "[crawler-health] ...broken", label `priority:high` | selector drift, parser da rigenerare |
| `follow-up` | "follow-up(#NNN)", label `follow-up` | micro-task / verifica deferred |
| `revenue` | label `revenue` / `rpm-canary`, "RPM canary" | monetizzazione, strategico |
| `tracker` | "master tracker", "recovery", senza label automation | piano umano multi-step |
| `other` | nessun match | da triage manuale |

## Triage flow (`issue-triage.yml`, on `issues: opened`)

1. **Classifica** l'issue in UNA categoria.
2. **Dedup**: confronta con le issue aperte. Una nuova issue è duplicate-storm se esiste un canonical aperto **più vecchio** della stessa categoria E stesso workflow/target (es. due "Validation Failure (dist)" consecutive, o due "[crawler-health] X broken" stessa company). Chiudi la nuova (`gh issue close --reason "not planned"`) con commento `Duplicate of #<canonical>`, applica label `duplicate`. **Mai chiudere il canonical.**
3. **Routing** (vedi sotto).
4. **Sempre** come ultimo step: applica `agent:triaged` (anche su issue chiuse come dup). Idempotenza: il workflow ha `if: !contains(labels,'agent:triaged')`.

### Routing policy

| Categoria | Azione triage |
|---|---|
| `crawler` | **Auto-route `agent:fix`.** Regen parser deterministico, basso blast-radius, coperto da `generate-company-parser.mjs`. |
| `follow-up` | **Auto-route `agent:fix`.** Micro-task / verifica deferred, basso blast-radius. |
| `validation-failure` | **Auto-route `agent:fix` SOLO se non transiente/storm-dup.** Spesso transiente → in dubbio, no fix. |
| `revenue` / `tracker` | NO auto-fix MAI. Giudizio strategico → mano umana (`/fix-issue` locale o manuale). |
| `other` | NO auto-fix. Commento "needs manual triage". |

**Meccanismo di routing (decision-file + PAT)**: l'agent del triage NON applica lui la label `agent:fix`. Scrive la decisione in `triage-decision.json` (`{"autofix": bool, "category": ...}`) come ultimo passo. Lo step CI `Apply agent:fix via PAT` la legge e applica `agent:fix` **via `GITHUB_PAT` in un `run:` diretto** (non dentro la claude-action), con guard `state == OPEN`. Perché così:
- **PAT, non GITHUB_TOKEN**: un `labeled` da GITHUB_TOKEN non triggera `issue-fix` (anti-ricorsione) e ha sender `github-actions[bot]` che non passa il gate `sender == valerielinc-ops || claude*`. Col PAT (owner) trigger+gate OK. Pattern identico ad `auto-merge-on-lgtm.yml` (gh in `run:` step).
- **`run:` diretto, non dentro l'action**: non dipendiamo da come `claude-code-action` propaga `GH_TOKEN` al subprocess `gh` dell'agent (assunzione non verificabile → review #922 ❓). Token deterministico.
- **Guard `state == OPEN`**: se l'agent ha chiuso l'issue come storm-duplicate, niente `agent:fix` → niente fixer sprecato. Vale per TUTTE le categorie auto-route, non solo validation-failure.
- Senza PAT (RC non caricato) → skip + warning: routing inerte, mai fixer via GITHUB_TOKEN.

`revenue`/`tracker` restano opt-in manuale (mai automation cieca su revenue/funnel — AGENTS.md).

### Frugalità quota (no ANTHROPIC_API_KEY)

Tutte le automazioni Claude (triage/review/fix/followup) usano **solo `CLAUDE_CODE_OAUTH_TOKEN`** (Max sub, zero costo $) → condividono la quota della sessione interattiva owner. Burst di issue = quota esaurita. Leve attive:

- **No fixer su dup**: lo step `Apply agent:fix via PAT` salta le issue dedup-chiuse (guard `state==OPEN`) → mai un run Claude fixer + branch/PR sprecato su uno storm-duplicate.
- Concurrency `cancel-in-progress: false` serializza (un run alla volta, no burst parallelo).
- Dedup-storm chiude i duplicati PRIMA del routing → un solo fixer per canonical.
- Triage = sonnet, `--max-turns 12` (NON tagliato: budget basso troncherebbe prima dell'`agent:triaged`/decisione obbligatori → `error_max_turns`, cfr. lever non misurate #795/#802 revertate). Review/fix idem (quality gate #838).
- **Driver residuo non mitigato**: il NUMERO di issue (es. storm follow-up da `post-merge-followup`, #887→4). Ridurre il volume di follow-up issue (batchare in 1 issue invece di N) è la leva più grossa se la quota resta stretta. Vedi PR #922 → "Non implementato".

## Fix flow (`issue-fix.yml`, on `issues: labeled == agent:fix`)

Trigger sull'aggiunta della label `agent:fix`. La label È il consenso. Può metterla l'owner (manuale) **o il triage** — quest'ultimo solo via `GITHUB_PAT` nello step `Apply agent:fix via PAT` (vedi "Meccanismo di routing" sopra; mai via `GITHUB_TOKEN`).

1. **Pre-check**: PR aperta già citante la issue → skip. Categoria `revenue`/`tracker` → abort con commento.
2. Branch `fix/issue-<N>`.
3. Diagnosi **root cause** (non sintomo). `crawler` → rigenera parser / edit mirato selector+config.
4. Fix **chirurgico** (AGENTS.md #6). Mai abbassare gate (#1). Mai disabilitare Auto Ads (#7).
5. Commit identity canonica `Valerie Linc <valerielinc@gmail.com>`. No path home assoluti, no email personali (Privacy).
6. Push branch + `gh pr create`.
7. PR body OBBLIGATORIO `## Implementato` (con `Closes #N`) + `## Non implementato (ancora)` (REVIEW.md completeness contract).
8. La PR fluisce in `pr-review-loop` → `## LGTM` → `auto-merge-on-lgtm`. **L'agent NON mergia a mano.**

### Tier (mirror di pr-review-loop)

| Tier | Trigger | Model / max-turns |
|---|---|---|
| high | issue tocca `crawler`/`parser`/`scripts/`/`build-plugin`/`.github/workflows/`/test gate | opus, 40 |
| normal | resto | sonnet, 30 |

### Abort senza PR (no fix forzato)

- Root cause non determinabile con confidenza → commento "serve indagine umana" + termina.
- Fix richiede credenziali/segreti non in CI → documenta + termina.
- Mai un fix speculativo pur di produrre una PR.

## Local fixer (`/fix-issue N`)

Per le categorie strategiche (`revenue`, `tracker`) o issue HIGH-risk dove vuoi supervisione: worktree-first, GitNexus impact, approvazione umana prima del push.

> ⚠️ `.gitignore` ignora `.claude/` (eccetto `settings.json`), quindi il file del comando `/fix-issue` **non è version-controlled**: vive solo localmente in `.claude/commands/fix-issue.md`. Lo spec completo è riprodotto qui sotto (Appendice A) per ricrearlo su qualsiasi clone.

## Label

| Label | Significato | Chi la mette |
|---|---|---|
| `agent:fix` | opt-in: l'agent tenta un fix → PR | triage (`crawler`/`follow-up`/`validation-failure` non-storm, **via PAT**) o owner manuale |
| `agent:triaged` | issue già processata da triage | triage (anti-loop) |
| `duplicate` | storm-duplicate, chiusa | triage |

## Kill-switch

- Disattivare auto-fix di una categoria: in `issue-triage.yml` togliere la categoria dal ramo che applica `agent:fix`, oppure disabilitare il workflow da GitHub UI.
- Disattivare TUTTO l'auto-routing mantenendo classify/dedup: rimuovere il `GITHUB_PAT` da Remote Config (o azzerare la Firebase SA) → triage ripiega su `GITHUB_TOKEN` e le label `agent:fix` smettono di triggerare il fixer.
- Bloccare un singolo fix: rimuovere `agent:fix` dalla issue prima che il fixer apra la PR (concurrency serializza, c'è una finestra).
- Pausa totale: disabilitare `issue-fix.yml` / `issue-triage.yml` (Actions → workflow → Disable).

## Guardrail (da AGENTS.md, vincolanti)

- Opt-in strategico: mai `agent:fix` automatico su `revenue`/`tracker`. Auto-route consentito solo su `crawler`/`follow-up`/`validation-failure` (non-storm).
- Concurrency cap: un fixer/triage alla volta (no OOM, no PR concorrenti su stesso data file).
- PR sempre via reviewer + `## LGTM`; mai bypass auto-merge.
- Changes chirurgiche, root-cause, no drive-by.
- Privacy: identity canonica, no path home, no email personali.

---

## Appendice A — `.claude/commands/fix-issue.md` (local-only, non tracciato)

Salva questo contenuto in `.claude/commands/fix-issue.md` su ogni clone dove vuoi il comando `/fix-issue` (è gitignored, vedi sopra).

````markdown
---
description: Fix a GitHub issue locally with human supervision (worktree-first, GitNexus impact). For strategic/high-risk issues the CI fixer shouldn't auto-handle.
argument-hint: <issue-number>
allowed-tools: Bash(gh:*), Bash(git:*), Bash(npm:*), Bash(node:*), Read, Grep, Glob, Edit, Write
---

Fix locale supervisionato della issue **#$ARGUMENTS**.

Companion locale di `issue-fix.yml` (CI). Usalo per le categorie che la pipeline NON auto-fixa: `revenue`, `tracker`, o issue HIGH-risk dove vuoi controllo. Differenza chiave: **tu approvi prima del push**.

## Bootstrap
1. Leggi `ISSUES.md` → "Fix flow" e `AGENTS.md` (non-negotiables + Privacy + Workflow).
2. `gh issue view $ARGUMENTS --json number,title,body,labels,comments`.
3. Classifica la categoria (ISSUES.md → Categorie).

## Pre-condizioni
- PR aperta già citante `#$ARGUMENTS` → fermati (no doppione).
- Worktree-first obbligatorio: `git fetch origin main` + verifica `git rev-parse main` == `git rev-parse origin/main`; se divergono basa il worktree su `origin/main`.

## Flow
1. `git worktree add .claude/worktrees/fix-issue-$ARGUMENTS origin/main -b fix/issue-$ARGUMENTS`.
2. GitNexus impact PRIMA di editare function/class/method. HIGH/CRITICAL → fermati e avvisa.
3. Diagnosi root cause (non sintomo). `gitnexus_query` non grep cieco.
4. Fix chirurgico: no drive-by, no speculative abstraction. Mai abbassare gate, mai disabilitare Auto Ads.
5. STOP — mostra il diff e attendi approvazione umana prima di commit/push.
6. Dopo OK: `gitnexus_detect_changes()`, poi commit (identity `Valerie Linc <valerielinc@gmail.com>`, no path home, no email personali).
7. Push + `gh pr create`. Body `## Implementato` (`Closes #$ARGUMENTS`) + `## Non implementato (ancora)`.
8. PR → `pr-review-loop` → `## LGTM` → auto-merge. Attendi `MERGED`, poi rimuovi worktree + branch + ref remoto.

## Constraint
- Approvazione umana del diff prima del push.
- Una issue alla volta, changes chirurgiche.
- Reviewer + `## LGTM`; mai merge a mano (salvo eccezione workflow-file AGENTS.md).
````

