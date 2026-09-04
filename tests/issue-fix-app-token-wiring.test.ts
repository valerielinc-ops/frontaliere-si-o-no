/**
 * Pins the `workflows`-scope wiring in issue-fix.yml (2026-08-06).
 *
 * The autonomous fixer could never modify `.github/workflows/**`: it ran on
 * `secrets.GITHUB_TOKEN`, which has no `workflows` scope, so the push was always
 * rejected. Three guards were built to detect it early because each occurrence burned
 * ~1M tokens (escalation #3887). The GitHub App `frontaliere-automation` was then granted
 * `workflows: write` — but a permission alone changes nothing while the workflow keeps
 * using the wrong token, which is exactly the state this file now prevents from returning.
 *
 * These are structural assertions on the YAML, not behaviour tests: every one of them
 * guards a step that fails SILENTLY. A missing mint leaves the fixer blocked with no
 * error; a missing extraheader unset sends the push back to GITHUB_TOKEN with no error;
 * an unconditional guard blocks a capability the fixer now has, with no error.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(__dirname, '../.github/workflows/issue-fix.yml');
const raw = readFileSync(WORKFLOW, 'utf8');
const wf = parse(raw);
const steps = wf.jobs.fix.steps as Array<Record<string, unknown>>;
const stepNamed = (re: RegExp) => steps.find((s) => re.test(String(s.name || '')));

describe('issue-fix.yml — App token wiring', () => {
  it('mints the App token before every gate that depends on it', () => {
    const mint = stepNamed(/Mint GitHub App token/);
    expect(mint, 'the mint step must exist').toBeTruthy();
    expect(String(mint!.run)).toContain('mint-app-token.mjs');

    // Order matters: the scope guard and the git remote both read env.APP_TOKEN, so a mint
    // placed after either of them would silently do nothing for them.
    const mintIdx = steps.indexOf(mint!);
    const guardIdx = steps.indexOf(stepNamed(/workflows-scope capability guard/)!);
    const gitIdx = steps.indexOf(stepNamed(/Configure git identity/)!);
    expect(mintIdx).toBeGreaterThanOrEqual(0);
    expect(mintIdx).toBeLessThan(guardIdx);
    expect(mintIdx).toBeLessThan(gitIdx);
  });

  it('does not let a failed mint fail the job', () => {
    // mint-app-token.mjs exits 0 on missing creds by design; continue-on-error covers the
    // infra faults it cannot catch. A mint that hard-fails would strand every issue.
    expect(stepNamed(/Mint GitHub App token/)!['continue-on-error']).toBe(true);
  });

  it('runs the workflows-scope guard on the VERIFIED capability, not on token presence', () => {
    // Conditional, not removed. With the capability the fixer HAS the scope and blocking
    // it a priori would remove something it owns; without it we are back in the state the
    // guard was built for. Since the mint fails silently, the degradation has to be
    // automatic rather than remembered.
    //
    // #5288: gating on `env.APP_TOKEN == ''` was the bug. The mint returns 201 and a
    // usable token even when `workflows` was requested but never approved on the
    // installation — the permission is simply absent from `permissions`. Presence
    // therefore proved nothing, the guard was skipped, the prompt asserted the scope,
    // and the push was rejected only at the END of the run (#5280): ~1M tokens instead
    // of 0. `APP_TOKEN_WORKFLOWS` is read from the API response, and `!= 'true'` is
    // fail-closed — unset (mint never ran, or failed) still runs the guard.
    const guard = stepNamed(/workflows-scope capability guard/);
    expect(String(guard!.if)).toContain("env.APP_TOKEN_WORKFLOWS != 'true'");
    expect(String(guard!.if)).not.toContain("env.APP_TOKEN == ''");
  });

  it('publishes the capability as its own signal, separate from the token', () => {
    // Il token continua a essere scritto anche senza `workflows`: ~23 workflow lo usano
    // come IDENTITÀ di push/dispatch e regredirebbero a `github-actions[bot]`.
    const mint = readFileSync(resolve(__dirname, '../scripts/ci/mint-app-token.mjs'), 'utf8');
    expect(mint).toContain('APP_TOKEN_WORKFLOWS');
    expect(mint).toContain('hasWorkflowsWrite');
    expect(mint).toContain('tok.body.permissions');
  });

  it('points the git remote at the App token, and clears the header that would override it', () => {
    const git = String(stepNamed(/Configure git identity/)!.run);
    expect(git).toContain('git remote set-url origin');
    expect(git).toContain('x-access-token:${APP_TOKEN}');
    // Trap #1 of TWO. actions/checkout writes
    // `http.https://github.com/.extraheader = AUTHORIZATION: basic <GITHUB_TOKEN>`, which
    // takes precedence over the URL credential — drop this unset and the push silently
    // reverts to the token without the scope. Same cause, same fix as pr-redflag-fixer.yml.
    // Trap #2 is LATER and was missed for weeks: claude-code-action rewrites this same
    // remote when it starts. It is pinned by the `github_token` block further down — this
    // step alone does NOT make the App token survive to `git push`.
    expect(git).toContain('--unset-all');
    expect(git).toContain('http.https://github.com/.extraheader');
    // And it must stay conditional: with no token, rewriting the remote to
    // `x-access-token:@github.com` would break pushes that work today.
    expect(git).toMatch(/if \[ -n "\$\{APP_TOKEN:-\}" \]/);
  });

  // 2026-08-30: the capability-guard and secrets-note text used to sit inline
  // in the "Run Claude fix" prompt as a `${{ cond && 'A' || 'B' }}` GitHub
  // Actions ternary. That pushed the `prompt:` scalar's total size (it also
  // holds ~9 other expressions across ~300 lines) past a real, undocumented
  // GitHub Actions limit — somewhere between 21,253 and 21,514 characters,
  // measured empirically by bisecting a push against a real branch (no
  // annotation, no actionlint/YAML.parse error, just a `failure` run with
  // ZERO jobs scheduled: "workflow file issue"). It had been silently broken
  // since 2026-08-30 08:45 UTC (PR #6678) — `agent:fix` never fired a single
  // real run in that window despite issues being labeled. Both texts moved to
  // the "Determine fix tier" step's bash script (id: `tier`), computed once
  // and exposed via `$GITHUB_OUTPUT` (`capability_guard`, `secrets_note`);
  // the prompt now references them as short `${{ steps.tier.outputs.* }}`
  // expressions instead of carrying the literal text itself.
  const tierStep = steps.find((s) => /Determine fix tier/.test(String(s.name || '')))!;
  const tierScript = String(tierStep.run);

  it('tells the agent the truth about its own capability, in both states', () => {
    // A correctly-wired token is wasted if the prompt still declares the scope missing:
    // the agent reads that line at turn 1 and terminates on its own.
    expect(tierScript).toContain('CONFERMATO `permissions.workflows == write`');
    expect(tierScript).toContain('NON ha lo scope `workflows`');
    // #5288: la frase che l'agente legge deve dipendere dalla capacità verificata. Sul
    // solo `APP_TOKEN != ''` il prompt affermava il falso — «hai lo scope, procedi» — e
    // l'agente implementava tutto prima di scoprire il rifiuto al push.
    expect(tierScript).toMatch(/APP_TOKEN_WORKFLOWS:-\}"\s*=\s*"true"/);
    expect(tierScript).not.toContain('APP_TOKEN:-} != ');

    // The prompt itself must actually read what the tier step computed.
    const claude = steps.find((s) => /Run Claude fix/.test(String(s.name || '')))!;
    const prompt = JSON.stringify(claude);
    expect(prompt).toContain('${{ steps.tier.outputs.capability_guard }}');
  });

  it('has the secret it once lacked (decision 2026-08-24): Remote Config is loaded before the run', () => {
    // Until 2026-08-24 the prompt told the agent the opposite of what this asserts now —
    // "NON hai PAT/Firebase SA" — and that line was true: the fixer ran with no Remote
    // Config loaded, so `blocked-secrets` was a real capability gap, not a stale verdict.
    // The owner then authorized secret USE from the autonomous loop permanently (VISION.md
    // registry), and `issue-fix.yml` grew a Firebase SA + `load-rc-env.mjs` step for it
    // (same commit that removed the old sentence this test used to check for). A prompt
    // still telling the agent "you have no PAT/Firebase SA" after that step runs would be
    // asserting a capability gap that no longer exists — precisely the class of stale-prompt
    // bug this file exists to pin.
    const saStep = steps.find((s) => /Firebase SA per Remote Config/.test(String(s.name || '')));
    expect(saStep, 'the Firebase SA step must exist').toBeTruthy();
    const rcStep = steps.find((s) => /Load secrets from Remote Config \(decisione 2026-08-24\)/.test(String(s.name || '')));
    expect(rcStep, 'the Remote Config load step must exist').toBeTruthy();
    expect(String(rcStep!.run)).toContain('load-rc-env.mjs');

    const saIdx = steps.indexOf(saStep!);
    const rcIdx = steps.indexOf(rcStep!);
    const claudeIdx = steps.indexOf(steps.find((s) => /Run Claude fix/.test(String(s.name || '')))!);
    // Order matters here too: loading secrets after the agent has already run would leave
    // `process.env` empty for the whole implementation window.
    expect(saIdx).toBeLessThan(claudeIdx);
    expect(rcIdx).toBeLessThan(claudeIdx);

    expect(tierScript).toContain('I SEGRETI CI SONO');
    expect(tierScript).toContain('CF_API_TOKEN');
    // The sentence this test used to require must be GONE, not just unrequired: its
    // presence today would mean the prompt lies about a capability the run actually has.
    expect(tierScript).not.toContain('NON hai PAT/Firebase SA');

    const prompt = JSON.stringify(steps.find((s) => /Run Claude fix/.test(String(s.name || '')))!);
    expect(prompt).toContain('${{ steps.tier.outputs.secrets_note }}');
  });

  it('still distinguishes workflows-scope from repo-setting/admin-API access', () => {
    // Secrets and the App token grant real capabilities, but neither grants GitHub's
    // repo-settings/branch-protection admin API — that gap is real and stays real, and the
    // prompt must not paper over it now that the secrets sentence changed.
    expect(tierScript).toContain('repo-setting/branch-protection/admin-API');
    expect(tierScript).toContain('blocked-admin-settings');
  });
});

describe('il token della App deve SOPRAVVIVERE fino al `git push` (#5595)', () => {
  // Il buco che ha reso inutile tutto il cablaggio qui sopra per settimane.
  //
  // `Configure git identity` puntava il remote sull'App token, il conio confermava
  // `workflows=write`, il log stampava «scope workflows CONFERMATO» — e il push moriva
  // comunque con «refusing to allow a GitHub App to create or update workflow … without
  // `workflows` permission». Il motivo non era il permesso: era CHI pushava.
  //
  // `claude-code-action`, in `src/github/operations/git-config.ts`, chiama
  // `configureGitAuth()` → `replaceCheckoutCredentials()`, che esegue un
  // `git remote set-url origin https://x-access-token:<token>@github.com/…`
  // INCONDIZIONATO. Quando `github_token` non è passato in input, quel `<token>` è quello
  // che la action si conia da sé (App `claude`) — e quella App non ha `workflows: write`.
  // Ogni riga di configurazione git del workflow veniva quindi sovrascritta all'avvio
  // della action, senza un errore e senza una riga di log del workflow che lo dicesse.
  //
  // Misurato sulla issue #5595 (run 31464108396, 2026-08-11): `"github_token": ""` negli
  // input della action, `mint-app-token: … workflows=write` nel log, push rifiutato lo
  // stesso. Il fix era completo (254 righe, 3 file) ed è sopravvissuto solo come commento.
  const wfDir = resolve(__dirname, '../.github/workflows');

  it('issue-fix passa l\'App token alla action, non solo al remote', () => {
    const claude = steps.find((s) => /Run Claude fix/.test(String(s.name || '')))!;
    const withBlock = (claude.with || {}) as Record<string, string>;
    expect(String(withBlock.github_token)).toBe('${{ env.APP_TOKEN }}');
  });

  it('il fallback è la stringa vuota, MAI GITHUB_TOKEN', () => {
    // `env.APP_TOKEN` non scritto → `''` → ramo di default della action (`inputs.github_token
    // == ''`): conia il suo token e lo revoca, cioè il comportamento pre-fix, invariato.
    // `secrets.GITHUB_TOKEN` come fallback sarebbe una REGRESSIONE, non una rete di
    // sicurezza: gli eventi di GITHUB_TOKEN non ri-triggerano i workflow a valle
    // (anti-ricorsione), quindi `tests` e `pr-review-loop` non partirebbero più sulle PR
    // del fixer — che resterebbero ferme per sempre, senza review e senza auto-merge.
    for (const file of ['issue-fix.yml', 'pr-redflag-fixer.yml', 'pr-redcheck-fixer.yml']) {
      const text = readFileSync(resolve(wfDir, file), 'utf8');
      const line = text.split('\n').find((l) => l.trim().startsWith('github_token:'));
      expect(line, `${file} deve passare github_token alla action`).toBeTruthy();
      expect(line).not.toContain('secrets.GITHUB_TOKEN');
      expect(line).toContain('env.APP_TOKEN');
    }
  });

  it('il 🔴-fixer usa per la action la STESSA identità del suo push remote', () => {
    // Stesso difetto, stesso file gemello: il suo prompt dichiara all'agente «il remote
    // origin è già autenticato con l'App token», affermazione che la action smentiva
    // riscrivendo il remote un istante prima che l'agente la leggesse.
    const text = readFileSync(resolve(wfDir, 'pr-redflag-fixer.yml'), 'utf8');
    expect(text).toMatch(/PUSH_TOKEN: \$\{\{ env\.APP_TOKEN \|\| env\.GITHUB_PAT \}\}/);
    expect(text).toMatch(/github_token: \$\{\{ env\.APP_TOKEN \|\| env\.GITHUB_PAT \}\}/);
  });

  it('INVARIANTE DI CLASSE: chi autentica un remote e poi lancia la action deve passarle il token', () => {
    // Il guard che conta. I due file sopra sono i casi noti; questo impedisce al difetto
    // di rientrare da un TERZO workflow scritto domani. La firma è meccanica: un workflow
    // che si costruisce un remote autenticato (`x-access-token:`) e poi invoca
    // `claude-code-action` sta assumendo che quel remote sopravviva — e non sopravvive,
    // a meno che non passi `github_token`.
    const offenders: string[] = [];
    for (const file of readdirSync(wfDir).filter((f) => f.endsWith('.yml'))) {
      const text = readFileSync(resolve(wfDir, file), 'utf8');
      const buildsAuthedRemote = text.includes('x-access-token:');
      const runsAction = text.includes('anthropics/claude-code-action');
      if (!buildsAuthedRemote || !runsAction) continue;
      const passesToken = text
        .split('\n')
        .some((l) => l.trim().startsWith('github_token:') && l.includes('env.APP_TOKEN'));
      if (!passesToken) offenders.push(file);
    }
    expect(
      offenders,
      `questi workflow autenticano un remote che claude-code-action sovrascriverà: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});

describe('i sibling che assumevano l\'assenza dello scope (review round 1)', () => {
  const redflag = readFileSync(resolve(__dirname, '../.github/workflows/pr-redflag-fixer.yml'), 'utf8');
  const drainer = readFileSync(resolve(__dirname, '../scripts/ci/followup-drainer.mjs'), 'utf8');

  it('il capability guard del 🔴-fixer legge la CAPACITÀ, non la presenza del token', () => {
    // Era legato al solo GITHUB_PAT, con un commento che lo giustificava dicendo che la App
    // non ha lo scope workflows — vero fino al 2026-08-06. Lasciarlo avrebbe fatto saltare i
    // fix su .github/workflows/** con la motivazione "serve un PAT abilitato" mentre il push
    // sarebbe passato: la stessa capability sbloccata in un posto e ancora rifiutata nel gemello.
    //
    // #5288, il verso opposto e più costoso: sulla sola PRESENZA il guard lasciava
    // PROCEDERE un fix che il push avrebbe poi rifiutato — un turno Claude intero speso e
    // buttato, cioè esattamente ciò che il guard esiste per evitare.
    expect(redflag).toMatch(/HAS_PAT: \$\{\{ env\.APP_TOKEN_WORKFLOWS == 'true' \|\| env\.GITHUB_PAT != '' \}\}/);
  });

  it('capacità e identità restano due domande distinte nel 🔴-fixer', () => {
    // Il guard chiede «posso pushare file workflow?» → capacità verificata.
    // Il push step chiede «con quale identità pusho?» → basta il token, perché l'App
    // ri-triggera pr-review-loop anche senza lo scope `workflows`. Confondere le due
    // (in un verso o nell'altro) è la classe di bug di #5288.
    expect(redflag).toMatch(/PUSH_TOKEN: \$\{\{ env\.APP_TOKEN \|\| env\.GITHUB_PAT \}\}/);
    expect(redflag).toMatch(/if: steps\.guard\.outputs\.proceed == 'true' && \(env\.APP_TOKEN != '' \|\| env\.GITHUB_PAT != ''\)/);
  });

  it('il drainer non parcheggia più come terminale quando issue-fix può DAVVERO pushare', () => {
    // Il parcheggio è TERMINALE (fu-parked) e porta una motivazione scritta. Con la capability
    // sbloccata quella motivazione è falsa, e una follow-up archiviata con una spiegazione
    // sbagliata non viene più rimessa in discussione da nessuno.
    //
    // Ma la presenza di APP_TOKEN non è la capability (#5288), e qui sbagliava nel verso
    // peggiore: SBLOCCAVA la promozione di follow-up che il push avrebbe rifiutato,
    // mandandole a bruciare ~1M token ciascuna per morire al `git push`.
    // Dal 2026-09-04 la capacità arriva da `canPushWorkflows()` e non piu' da una
    // singola env: `APP_TOKEN_WORKFLOWS` descrive la sola GitHub App del sito, e il
    // corpus — che pusha con un PAT classico con scope `workflow` — otteneva `false`
    // PER COSTRUZIONE, parcheggiando come terminali fix perfettamente pushabili
    // (corpus #758 #754 #714 #659). Il guard gemello `isCapabilityScoped` era gia'
    // passato a `canPushWorkflows()` il 2026-08-24: questo call-site era rimasto
    // indietro. Il fail-closed non cambia — `canPushWorkflows()` e' l'OR di due
    // letture, entrambe `!== 'true'` quando non scritte.
    expect(drainer).toMatch(/const issueFixCanPushWorkflows = canPushWorkflows\(\);/);
    expect(drainer).not.toMatch(/const issueFixCanPushWorkflows = process\.env\./);
    expect(drainer).toMatch(/if \(!issueFixCanPushWorkflows && body && detectWorkflowScoped/);
  });
});

describe('secrets: USO autorizzato ≠ ROTAZIONE (review round 2, #6333)', () => {
  // Trovato dalla review su #6333: il capability-guard aggiornato dice "USALA" per
  // qualunque fix che richiede una credenziale, ma non distingue "usare un secret che
  // c'è" da "ruotarlo/rigenerarlo/revocarlo" — un'azione fuori-banda che nessuna
  // variabile in process.env può soddisfare. VISION.md distingue le due cose (uso
  // autorizzato il 24-08, rotazione dichiarata umana il 18-08); senza quella
  // distinzione riportata anche in ISSUES.md, un'issue di rotazione rischiava di far
  // tentare al fixer un'implementazione impossibile invece di abortire al turno 1 —
  // lo stesso spreco (~1M token/run) che questa PR misura ed elimina, nella direzione
  // opposta.
  const issues = readFileSync(resolve(__dirname, '../ISSUES.md'), 'utf8');

  it('ISSUES.md dice di USARE una credenziale disponibile, non più di abortire', () => {
    expect(issues).toContain('I segreti CI SONO');
    expect(issues).toMatch(/richiede una credenziale va \*\*IMPLEMENTATO\*\*/);
    expect(issues).not.toContain('Fix richiede credenziali/segreti non in CI → documenta + termina.');
  });

  it('ISSUES.md porta l\'eccezione esplicita per la rotazione', () => {
    expect(issues).toMatch(/rotazione di credenziali/i);
    expect(issues).toContain('resta una decisione umana');
  });

  it('la stessa distinzione vive anche nel prompt di issue-fix.yml', () => {
    expect(raw).toContain('I SEGRETI CI SONO');
  });
});
