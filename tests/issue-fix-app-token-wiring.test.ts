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
import { readFileSync } from 'node:fs';
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
    // THE trap. actions/checkout writes
    // `http.https://github.com/.extraheader = AUTHORIZATION: basic <GITHUB_TOKEN>`, which
    // takes precedence over the URL credential — drop this unset and the push silently
    // reverts to the token without the scope. Same cause, same fix as pr-redflag-fixer.yml.
    expect(git).toContain('--unset-all');
    expect(git).toContain('http.https://github.com/.extraheader');
    // And it must stay conditional: with no token, rewriting the remote to
    // `x-access-token:@github.com` would break pushes that work today.
    expect(git).toMatch(/if \[ -n "\$\{APP_TOKEN:-\}" \]/);
  });

  it('tells the agent the truth about its own capability, in both states', () => {
    // A correctly-wired token is wasted if the prompt still declares the scope missing:
    // the agent reads that line at turn 1 and terminates on its own.
    const claude = steps.find((s) => /Run Claude fix/.test(String(s.name || '')))!;
    const prompt = JSON.stringify(claude);
    expect(prompt).toContain('CONFERMATO `permissions.workflows == write`');
    expect(prompt).toContain('NON ha lo scope `workflows`');
    // #5288: la frase che l'agente legge deve dipendere dalla capacità verificata. Sul
    // solo `APP_TOKEN != ''` il prompt affermava il falso — «hai lo scope, procedi» — e
    // l'agente implementava tutto prima di scoprire il rifiuto al push.
    expect(prompt).toContain("env.APP_TOKEN_WORKFLOWS == 'true'");
    expect(prompt).not.toContain("env.APP_TOKEN != ''");
  });

  it('still refuses the capabilities that remain genuinely absent', () => {
    // The App token grants `workflows`. It does NOT grant admin API or the Firebase-RC
    // secrets, and conflating "can push workflows" with "can do anything" would send the
    // agent to implement fixes it can never land.
    const prompt = JSON.stringify(steps.find((s) => /Run Claude fix/.test(String(s.name || '')))!);
    expect(prompt).toContain('NON hai PAT/Firebase SA');
    expect(prompt).toContain('CF_API_TOKEN');
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
    expect(drainer).toMatch(/const issueFixCanPushWorkflows = process\.env\.APP_TOKEN_WORKFLOWS === 'true'/);
    expect(drainer).toMatch(/if \(!issueFixCanPushWorkflows && body && detectWorkflowScoped/);
  });
});
