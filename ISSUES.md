# Issue Automation Instructions

Contratto operativo per la pipeline issue-agent: `issue-triage.yml` (classify + route **deterministico, no Claude**) e `issue-fix.yml` (fix → PR). Companion locale: `/fix-issue N` (`.claude/commands/fix-issue.md`).

## Scopo

Le issue di questo repo sono per lo più **auto-generate dai monitor** (post-deploy validate dist/live, crawler-health, rpm-canary, follow-up post-merge). Vanno instradate per categoria, non trattate da un singolo agent indistinto. Obiettivo: risolvere autonomamente le categorie deterministiche, lasciando alla mano umana solo lo strategico.

**Dedup a MONTE, non nel triage.** I duplicati non vanno chiusi dal triage (costerebbe un run per duplicato): vanno evitati alla sorgente. I monitor usano `scripts/lib/github-issue-creator.mjs` che, con **titolo stabile** (senza run-number), commenta 🔁 sull'issue canonica invece di aprirne una nuova. I follow-up sono **batchati in 1 issue aggregata per PR** da `post-merge-followup` (vedi `FOLLOWUP.md`, non N issue). Con i duplicati eliminati a monte, il triage si riduce a classificare+instradare → **puro bash, zero Claude, zero quota Max**.

## Categorie

| Categoria | Segnale (titolo/label) | Natura |
|---|---|---|
| `validation-failure` | "Validation Failure (dist\|live)", label `bug`+`priority:urgent` | alert post-deploy, spesso dupe/transiente |
| `crawler` | "Crawler Failure", "[crawler-health] ...broken", label `priority:high` | selector drift, parser da rigenerare |
| `follow-up` | "follow-up(#NNN)", label `follow-up` | micro-task / verifica deferred |
| `revenue` | label `revenue` / `rpm-canary`, "RPM canary" | monetizzazione, strategico |
| `tracker` | "master tracker", "recovery", senza label automation | piano umano multi-step |
| `other` | nessun match | da triage manuale |

## Triage flow (`issue-triage.yml`, on `issues: opened`) — deterministico, no Claude

Step bash unico (`Classify and route`), nessuna `claude-code-action`:

1. **Classifica** via regex su titolo+label → UNA categoria (ordine conservativo: revenue/tracker prima, mai auto-fix). Vedi tabella "Categorie".
2. **`agent:triaged`** sempre (anti-loop, idempotente: gate `if: !contains(labels,'agent:triaged')`).
3. **Commento** solo per `revenue`/`tracker`/`validation-failure`/`other` (categorie che restano umane). Nessun commento sulle categorie auto-route (no rumore).
4. **Routing** (vedi sotto): `agent:fix` via PAT solo per `crawler`/`follow-up`, issue OPEN.

Nessun dedup-close: i duplicati sono evitati a monte (vedi "Scopo"). Misclassificazione regex → fail-safe su `other` (nessun auto-fix). Triage non legge più la lista delle issue aperte (era input-token che cresceva col backlog).

### Routing policy

| Categoria | Azione triage |
|---|---|
| `crawler` | **Auto-route `agent:fix`.** Regen parser deterministico, basso blast-radius, coperto da `generate-company-parser.mjs`. |
| `follow-up` | **Auto-route `agent:fix`.** Micro-task / verifica deferred, basso blast-radius. |
| `validation-failure` | **NO auto-fix.** Spesso transiente; transiente-vs-persistente non è decidibile in modo deterministico (bash). Commento "verifica ricorrenza 🔁 prima di `agent:fix` manuale". |
| `revenue` / `tracker` | NO auto-fix MAI. Giudizio strategico → mano umana (`/fix-issue` locale o manuale). |
| `other` | NO auto-fix. Commento "needs manual triage". |

**Meccanismo di routing (PAT in bash)**: lo step `Classify and route` applica `agent:fix` **via `GITHUB_PAT` con `gh` diretto** (non in una claude-action), solo per `crawler`/`follow-up` e solo se l'issue è OPEN. Perché così:
- **PAT, non GITHUB_TOKEN**: un `labeled` da GITHUB_TOKEN non triggera `issue-fix` (anti-ricorsione) e ha sender `github-actions[bot]` che non passa il gate `sender == valerielinc-ops`. Col PAT (owner) trigger+gate OK. Pattern identico ad `auto-merge-on-lgtm.yml`.
- **Guard `state == OPEN`**: belt-and-suspenders contro race; niente `agent:fix` su issue chiuse.
- Senza PAT (RC non caricato) → skip + warning: routing inerte, mai fixer via GITHUB_TOKEN.

`revenue`/`tracker` restano opt-in manuale (mai automation cieca su revenue/funnel — AGENTS.md).

### Frugalità quota (no ANTHROPIC_API_KEY)

Tutte le automazioni Claude usano **solo `CLAUDE_CODE_OAUTH_TOKEN`** (Max sub, zero costo $) → condividono la quota della sessione interattiva owner. Burst di issue = quota esaurita. Frugalità per **architettura** (ridurre il numero di run Claude), non per taglio turni:

- **Triage = ZERO Claude**: classificazione regex in bash → eliminati ~50 run Claude/giorno (era il driver principale del session-limit). La quota Max non viene toccata dal triage.
- **Dedup a monte = meno issue → meno run a valle**: titolo stabile validation-failure (8→1 via 🔁) + batch follow-up 1-per-PR (era N) → molte meno issue aperte → molti meno trigger di `issue-fix`.
- **No fixer su issue non-OPEN**: il routing salta le issue chiuse.
- Concurrency `cancel-in-progress: false` serializza i fixer.
- **fix/review/followup restano Claude** (giudizio necessario): max-turns NON tagliati (quality gate; budget basso → `error_max_turns`, cfr. #795/#802/#838). Sono meno frequenti del triage e producono valore.
- **Residuo**: l'auto-route `follow-up` può auto-alimentarsi (fix→merge→followup→nuovo follow-up). Bound da: batch 1-issue/PR (meno volume), concurrency 1-alla-volta, gate `## LGTM`. Un fix pulito non genera nuovi follow-up → converge.

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
| `agent:fix` | opt-in: l'agent tenta un fix → PR | triage (`crawler`/`follow-up`, **via PAT**) o owner manuale |
| `agent:triaged` | issue già processata da triage | triage (anti-loop) |
| `duplicate` | storm-duplicate, chiusa | triage |

## Kill-switch

- Disattivare auto-fix di una categoria: in `issue-triage.yml` togliere la categoria dal ramo che applica `agent:fix`, oppure disabilitare il workflow da GitHub UI.
- Disattivare TUTTO l'auto-routing mantenendo classify/dedup: rimuovere il `GITHUB_PAT` da Remote Config (o azzerare la Firebase SA) → triage ripiega su `GITHUB_TOKEN` e le label `agent:fix` smettono di triggerare il fixer.
- Bloccare un singolo fix: rimuovere `agent:fix` dalla issue prima che il fixer apra la PR (concurrency serializza, c'è una finestra).
- Pausa totale: disabilitare `issue-fix.yml` / `issue-triage.yml` (Actions → workflow → Disable).

## Guardrail (da AGENTS.md, vincolanti)

- Opt-in strategico: mai `agent:fix` automatico su `revenue`/`tracker`/`validation-failure`. Auto-route consentito solo su `crawler`/`follow-up`.
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

