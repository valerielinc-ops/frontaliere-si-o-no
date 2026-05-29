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
| `crawler` | **Auto-applica `agent:fix`.** Regen parser è deterministico, basso blast-radius, già coperto da `generate-company-parser.mjs`. |
| `follow-up` | NO auto-fix. Commento classificazione + "apply `agent:fix` se vuoi tentativo autonomo". |
| `validation-failure` | NO auto-fix (spesso transiente — verifica prima la run successiva). Dedup aggressivo. Commento. |
| `revenue` / `tracker` | NO auto-fix MAI. Richiede giudizio strategico → mano umana (`/fix-issue` locale o manuale). |
| `other` | NO auto-fix. Commento "needs manual triage". |

Razionale opt-in: solo `crawler` è auto-instradato perché è l'unica categoria con un fix-path deterministico e ripetuto. Tutto il resto richiede consenso umano esplicito = aggiunta manuale della label `agent:fix`. Coerente con AGENTS.md (opt-in, no automation cieca su revenue/funnel).

## Fix flow (`issue-fix.yml`, on `issues: labeled == agent:fix`)

Trigger SOLO sull'aggiunta della label `agent:fix` da parte dell'owner. La label È il consenso.

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
| `agent:fix` | opt-in: l'agent tenta un fix → PR | triage (solo `crawler`) o owner manuale |
| `agent:triaged` | issue già processata da triage | triage (anti-loop) |
| `duplicate` | storm-duplicate, chiusa | triage |

## Kill-switch

- Disattivare auto-fix crawler: in `issue-triage.yml` rimuovere il ramo che applica `agent:fix`, oppure disabilitare il workflow da GitHub UI.
- Bloccare un singolo fix: rimuovere `agent:fix` dalla issue prima che il fixer apra la PR (concurrency serializza, c'è una finestra).
- Pausa totale: disabilitare `issue-fix.yml` / `issue-triage.yml` (Actions → workflow → Disable).

## Guardrail (da AGENTS.md, vincolanti)

- Opt-in: mai `agent:fix` automatico fuori da `crawler`.
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

