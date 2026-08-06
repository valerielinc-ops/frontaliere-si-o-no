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

  it('runs the workflows-scope guard ONLY when no App token was minted', () => {
    // Conditional, not removed. With a token the fixer HAS the scope and blocking it a
    // priori would remove a capability it now owns; without one we are back in the state
    // the guard was built for. Since the mint fails silently, the degradation has to be
    // automatic rather than remembered.
    const guard = stepNamed(/workflows-scope capability guard/);
    expect(String(guard!.if)).toContain("env.APP_TOKEN == ''");
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
    expect(prompt).toContain('HA lo scope `workflows`');
    expect(prompt).toContain('NON ha lo scope `workflows`');
    expect(prompt).toContain("env.APP_TOKEN != ''");
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
