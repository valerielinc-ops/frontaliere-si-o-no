/**
 * probe-workflow-scope — la lettura della capacità `workflow` dell'identità con
 * cui il FIXER pusha.
 *
 * Il difetto che chiude, misurato il 2026-08-24: il pre-flight
 * `blocked-workflows-scope` consultava solo `APP_TOKEN_WORKFLOWS`, che descrive
 * la GitHub App del sito. Il corpus non usa una App — pusha con
 * `GITHUB_PAT_NANAKO`, che HA lo scope `workflow` — quindi là la risposta era
 * `false` per costruzione e ogni fix che toccasse `.github/workflows/**` veniva
 * parcheggiato come impossibile. 8 verdetti in 7 giorni, TUTTI emessi dal
 * pre-flight e non da Claude, con un messaggio che parla di «token GitHub App»
 * su un repo che non ne ha uno.
 */

import { describe, it, expect } from 'vitest';
import { parseOauthScopes, hasWorkflowScope } from '../scripts/ci/probe-workflow-scope.mjs';
import { canPushWorkflows, canPushWorkflowsFromEnv } from '../scripts/ci/followup-drainer.mjs';

const PAT_HEADERS = [
  'HTTP/2.0 200 OK',
  'x-oauth-scopes: admin:org, delete_repo, gist, repo, user, workflow, write:packages',
  'x-accepted-oauth-scopes: ',
].join('\n');

const APP_HEADERS = ['HTTP/2.0 200 OK', 'x-github-api-version-selected: 2022-11-28'].join('\n');

describe('parseOauthScopes', () => {
  it('estrae e normalizza gli scope di un PAT classico', () => {
    expect(parseOauthScopes(PAT_HEADERS)).toContain('workflow');
    expect(parseOauthScopes(PAT_HEADERS)).toContain('repo');
  });

  it('header assente → null, che NON è "nessuno scope"', () => {
    // È la distinzione che tiene il sito invariato: un token di GitHub App non
    // espone `x-oauth-scopes`, e leggerlo come lista vuota direbbe «capacità
    // assente» su una capacità che `APP_TOKEN_WORKFLOWS` può invece confermare.
    expect(parseOauthScopes(APP_HEADERS)).toBeNull();
  });

  it('input vuoto o illeggibile → null', () => {
    expect(parseOauthScopes('')).toBeNull();
    expect(parseOauthScopes(undefined)).toBeNull();
  });

  it("l'header è case-insensitive (i server non garantiscono il caso)", () => {
    expect(parseOauthScopes('X-OAuth-Scopes: repo, workflow')).toEqual(['repo', 'workflow']);
  });
});

describe('hasWorkflowScope', () => {
  it('true solo se `workflow` è fra gli scope', () => {
    expect(hasWorkflowScope(PAT_HEADERS)).toBe(true);
    expect(hasWorkflowScope('x-oauth-scopes: repo, gist')).toBe(false);
  });

  it('non confonde un altro scope col nostro (`workflow` ≠ `write:workflows`)', () => {
    expect(hasWorkflowScope('x-oauth-scopes: repo, write:workflows')).toBe(false);
  });

  it('identità di App → false, e la decisione torna a APP_TOKEN_WORKFLOWS', () => {
    expect(hasWorkflowScope(APP_HEADERS)).toBe(false);
  });
});

describe('canPushWorkflows — le due sorgenti di capacità', () => {
  it('GitHub App confermata → true', () => {
    expect(canPushWorkflows({ APP_TOKEN_WORKFLOWS: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('PAT con scope workflow → true (il caso del corpus)', () => {
    expect(canPushWorkflows({ PAT_WORKFLOWS_SCOPE: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('nessuna delle due → false, fail-closed', () => {
    expect(canPushWorkflows({} as NodeJS.ProcessEnv)).toBe(false);
    expect(canPushWorkflows({ APP_TOKEN_WORKFLOWS: 'false', PAT_WORKFLOWS_SCOPE: 'false' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('una variabile non scritta non è mai "concessa"', () => {
    // Fail-closed per costruzione: qualunque valore diverso dalla stringa
    // `true` — compreso `undefined`, `'1'`, `'yes'` — lascia il guard armato.
    for (const v of [undefined, '1', 'yes', 'TRUE', '']) {
      expect(canPushWorkflows({ PAT_WORKFLOWS_SCOPE: v } as NodeJS.ProcessEnv)).toBe(false);
    }
  });

  it('`canPushWorkflowsFromEnv` resta la sola sorgente App, non la capacità totale', () => {
    // Il guard deve consultare `canPushWorkflows`; tenere separate le due è ciò
    // che rende visibile nei log QUALE identità concede il permesso.
    expect(canPushWorkflowsFromEnv({ PAT_WORKFLOWS_SCOPE: 'true' } as NodeJS.ProcessEnv)).toBe(false);
    expect(canPushWorkflows({ PAT_WORKFLOWS_SCOPE: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });
});
