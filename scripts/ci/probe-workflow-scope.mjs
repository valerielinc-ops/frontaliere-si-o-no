#!/usr/bin/env node
/**
 * probe-workflow-scope.mjs — scrive `PAT_WORKFLOWS_SCOPE` in `$GITHUB_ENV`
 * leggendo la capacità REALE dell'identità con cui `gh` sta girando.
 *
 * Perché esiste (misurato il 2026-08-24). Il pre-flight `blocked-workflows-scope`
 * del drainer consultava solo `APP_TOKEN_WORKFLOWS`, che descrive una sola
 * identità: la GitHub App del sito. Il corpus non usa una App — pusha con
 * `GITHUB_PAT_NANAKO`, che HA lo scope `workflow` — quindi là la risposta era
 * `false` per costruzione e il guard parcheggiava come «bloccata» ogni fix che
 * toccasse `.github/workflows/**`. 8 verdetti in 7 giorni, tutti emessi dal
 * pre-flight e non da Claude, con un messaggio che parla di «token GitHub App»
 * su un repo che non ne ha uno. Non era spreco di token: era lavoro pushabile
 * dichiarato impossibile.
 *
 * Il modo di scoprirlo è la lezione di #5288, e vale in entrambe le direzioni:
 * la capacità si LEGGE dall'API, non si deduce dalla presenza di un token. Un
 * PAT classico la espone nell'header `x-oauth-scopes`; per un token di GitHub
 * App quell'header è ASSENTE, e in quel caso questa sonda scrive `false` e la
 * decisione torna intera a `APP_TOKEN_WORKFLOWS` — cioè il comportamento del
 * sito non cambia di una riga.
 *
 * IL TOKEN VA PASSATO ESPLICITAMENTE in `PUSH_TOKEN`, e non è un dettaglio di
 * stile: la domanda a cui questa sonda risponde è «il FIXER può pushare quei
 * file?», e l'identità del fixer non è quella del processo che chiama la sonda.
 * Nel drainer del sito, per esempio, `GH_TOKEN` è `APP_TOKEN || GITHUB_PAT`:
 * sondare l'identità ambientale di `gh` là avrebbe letto gli scope di un PAT
 * che NON è la credenziale con cui `issue-fix` pusha, e un `workflow` trovato
 * su quel PAT avrebbe disarmato il guard sulla base di un token che non
 * c'entra. Senza `PUSH_TOKEN` la sonda non prova nemmeno: scrive `false`.
 *
 * FAIL-CLOSED e SEMPRE exit 0: qualunque errore scrive `false`, che è lo stato
 * conservativo (il guard resta armato). Uscire non-zero fermerebbe il drainer
 * per una sonda, che è l'opposto di cio' che serve — e una variabile non
 * scritta è comunque `!== 'true'`, quindi anche un crash totale degrada bene.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/** Estrae gli scope dall'header `x-oauth-scopes` di una risposta `gh api -i`. Pura. */
export function parseOauthScopes(rawHeaders) {
  const m = /^x-oauth-scopes:\s*(.*)$/im.exec(String(rawHeaders || ''));
  if (!m) return null; // header assente = token di App, non un PAT classico
  return m[1].split(',').map((x) => x.trim()).filter(Boolean);
}

/** Vero se gli scope letti includono `workflow`. Pura. */
export function hasWorkflowScope(rawHeaders) {
  const scopes = parseOauthScopes(rawHeaders);
  return Array.isArray(scopes) && scopes.includes('workflow');
}

function main() {
  let granted = false;
  let why = 'nessuna risposta leggibile';
  const token = process.env.PUSH_TOKEN;
  if (!token) {
    console.log('probe-workflow-scope: PAT_WORKFLOWS_SCOPE=false — `PUSH_TOKEN` non passato: la sonda non indovina quale identità userà il fixer.');
    write(false);
    return;
  }
  try {
    // `--jq empty` scarta il body e lascia i soli header: la sonda non deve
    // stampare il profilo dell'utente nel log di un workflow. `GH_TOKEN`
    // sovrascritto qui e SOLO qui: si interroga la credenziale del fixer, non
    // quella del processo chiamante.
    const raw = execFileSync('gh', ['api', '-i', 'user', '--jq', 'empty'], {
      encoding: 'utf8', maxBuffer: 1 << 20,
      env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
    });
    const scopes = parseOauthScopes(raw);
    if (scopes === null) {
      why = 'header `x-oauth-scopes` assente → identità GitHub App, decide APP_TOKEN_WORKFLOWS';
    } else {
      granted = scopes.includes('workflow');
      why = granted
        ? 'PAT classico con scope `workflow` → `.github/workflows/**` pushabile'
        : `PAT classico SENZA scope \`workflow\` (${scopes.length} scope letti) → guard armato`;
    }
  } catch (e) {
    why = `sonda fallita, fail-closed: ${String(e).slice(0, 120)}`;
  }
  console.log(`probe-workflow-scope: PAT_WORKFLOWS_SCOPE=${granted} — ${why}`);
  write(granted);
}

function write(granted) {
  const out = process.env.GITHUB_ENV;
  if (!out) return;
  try { appendFileSync(out, `PAT_WORKFLOWS_SCOPE=${granted}\n`); }
  catch (e) { console.log(`::warning::scrittura in GITHUB_ENV fallita: ${String(e).slice(0, 120)}`); }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
