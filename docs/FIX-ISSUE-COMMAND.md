# `/fix-issue N` — spec del comando locale (`.claude/commands/fix-issue.md`)

Estratto da `ISSUES.md` → "Appendice A" per non far entrare ~3,1 KB in ogni sessione agent (stesso pattern di `docs/AGENTS-HISTORY.md` e `docs/CI-CD-PIPELINE.md`). Il contratto operativo della pipeline issue resta in `ISSUES.md`; qui c'è solo lo spec da copiare, invariato.

`.gitignore` ignora `.claude/` (eccetto `settings.json`), quindi il file del comando **non è version-controlled**: salva questo contenuto **verbatim** in `.claude/commands/fix-issue.md` su ogni clone dove vuoi il comando `/fix-issue`.

````markdown
---
description: Fix a GitHub issue locally with human supervision (worktree-first, GitNexus impact). For strategic/high-risk issues the CI fixer shouldn't auto-handle.
argument-hint: <issue-number>
allowed-tools: Bash(gh:*), Bash(git:*), Bash(npm:*), Bash(node:*), Read, Grep, Glob, Edit, Write
---

Fix locale supervisionato della issue **#$ARGUMENTS**.

Companion locale di `issue-fix.yml` (CI). Usalo per issue HIGH-risk dove vuoi controllo, o per intervenire mano su una categoria (`revenue`, `tracker`, …) prima che il drainer la promuova dalla coda automatica. Differenza chiave: **tu approvi prima del push**.

## Bootstrap
1. Leggi `ISSUES.md` → "Fix flow" e `AGENTS.md` (non-negotiables + Privacy + Workflow).
2. `gh issue view $ARGUMENTS --json number,title,body,labels,comments`.
3. Classifica la categoria (ISSUES.md → Categorie).

## Pre-condizioni
- PR aperta già citante `#$ARGUMENTS` → fermati (no doppione).
- **Claim mutex** (#4788/#4793 — una sessione locale e `issue-fix.yml` hanno fixato la stessa issue in parallelo, due PR competitive in conflitto al merge): `gh issue view $ARGUMENTS --json labels` (già letto al Bootstrap 2). Se compare `agent:in-progress` → un'altra sessione (locale o il fixer CI) la sta già lavorando → fermati, avvisa l'utente, NON procedere. Se assente → reclamala SUBITO, prima di ogni altro passo: `gh label create agent:in-progress --color fbca04 --description "Fixer o sessione interattiva al lavoro ORA (mutex anti-doppione)" 2>/dev/null; gh issue edit $ARGUMENTS --add-label agent:in-progress`.
- Overlap-file: se una PR aperta modifica già un file target della issue (`gh pr list --state open` + `gh pr diff <n> --name-only`) → fermati (evita conflitto con lavoro in corso, es. #934 vs #943).
- Worktree-first obbligatorio: `git fetch origin main` + verifica `git rev-parse main` == `git rev-parse origin/main`; se divergono basa il worktree su `origin/main`.
- **Stati già dichiarati nei residui** (stessa regola di `issue-fix.yml` e `pr-redflag-fixer.yml` — AGENTS.md #6: la superficie locale non può contraddire quelle CI). Se la issue nasce da una PR, leggi `## Non implementato (ancora)` di quel body **riusando** la tassonomia, mai una regex tua:
  ```bash
  gh pr view <N> --json body -q .body > /tmp/pr-body.md
  node --input-type=module -e 'import { readFileSync } from "node:fs"; const { extractSection, sectionBullets, bulletState, NON_IMPL_ANCORA_RE } = await import("./scripts/lib/pr-body-sections-check.mjs"); const sec = extractSection(readFileSync("/tmp/pr-body.md","utf8"), NON_IMPL_ANCORA_RE) ?? ""; for (const b of sectionBullets(sec)) console.log(bulletState(b), "·", b);'
  ```
  `sectionBullets` applica `stripNonContent`: senza, gli esempi di stato dentro un blocco fenced del body si leggono come stati dichiarati. Qui il modulo si prende dal worktree (che è su `origin/main` fresco, vedi sopra) — in CI no, lì va preso da `main` esplicitamente perché il checkout è il branch della PR.
  **Tre stati CHIUDONO la voce** (`per scelta`, `by construction`, `blocked: decisione del proprietario` — i `CLOSING_STATES` di `scripts/ci/followup-has-candidates.mjs`), **tre no** (`in questa PR`, `PR concatenata #N`, `blocked: <causa tecnica>`). Se il bullet che copre il tema della issue è chiuso **col motivo scritto dopo lo stato**, non implementarlo: commenta citando il bullet verbatim e fermati. Prima di onorare il veto controlla che lo stato non stia dentro una negazione («non per scelta ma…»): `bulletState` vince sull'occorrenza più a sinistra e classificherebbe quel bullet come chiuso.

## Flow
1. `git worktree add .claude/worktrees/fix-issue-$ARGUMENTS origin/main -b fix/issue-$ARGUMENTS`.
2. GitNexus impact PRIMA di editare function/class/method. HIGH/CRITICAL → fermati e avvisa.
3. Diagnosi root cause (non sintomo). `gitnexus_query` non grep cieco.
4. Fix chirurgico: no drive-by, no speculative abstraction. Mai abbassare gate, mai disabilitare Auto Ads.
5. STOP — mostra il diff e attendi approvazione umana prima di commit/push.
6. Dopo OK: `gitnexus_detect_changes()`, poi commit (identity `Valerie Linc <valerielinc@gmail.com>`, no path home, no email personali).
7. Push + `gh pr create`. Body `## Implementato` + `## Non implementato (ancora)`.
   - **Riga di chiusura — NON scriverla a mano.** Calcolala: `gh issue view $ARGUMENTS --json number,title,body,labels | node scripts/lib/pr-body-generator-contract.mjs --closing-ref`. Stampa `Closes #N` oppure `Addresses #N`: `Addresses` quando la issue è una follow-up **aggregata multi-item**, su cui `pr-body-contract.yml` fallisce ogni `Closes` (la PR nasce rossa — successo reale #5848 e #5862) perché al merge chiuderebbe un'aggregata con item ancora dovuti.
   - **Ogni bullet di `## Non implementato (ancora)` vuole uno STATO LETTERALE**, scritto esattamente così (AGENTS.md #8; `out of scope` / `follow-up` / `posposto` sono la tassonomia ABOLITA): `in questa PR` · `PR concatenata #N` (col numero) · `per scelta` · `by construction` · `blocked: <causa esterna reale>`. Senza stato, `scripts/ci/followup-has-candidates.mjs` riapre il bullet come issue di follow-up nuova — anche se il lavoro è già chiuso. E `blocked:` non è monolitico: `blocked: decisione del proprietario` chiude la voce, ogni altra causa la lascia aperta e la fa riaccodare. Non dare uno stato chiudente a ciò che stai solo rimandando (esce dalla coda e il ciclo lo perde), né `blocked: <causa tecnica>` a ciò che è chiuso per decisione (rientra a ogni ciclo, per sempre).
8. PR → `pr-review-loop` → `## LGTM` → auto-merge. Attendi `MERGED`, poi rimuovi worktree + branch + ref remoto.
9. **Rilascia il claim** (a lavoro concluso o se abbandoni prima): `gh issue edit $ARGUMENTS --remove-label agent:in-progress`. Mai lasciarla stale — blocca il fixer CI su questa issue finché resta.

## Constraint
- Approvazione umana del diff prima del push.
- Una issue alla volta, changes chirurgiche.
- Reviewer + `## LGTM`; mai merge a mano (salvo eccezione workflow-file AGENTS.md).
````
