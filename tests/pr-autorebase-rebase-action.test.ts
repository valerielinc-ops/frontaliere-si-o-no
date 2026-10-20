/**
 * rebaseActionForLgtmPr — decisione di pr-autorebase per una PR near-merge
 * behind>0. Guard contro il LIVELOCK osservato 2026-06-17: una PR LGTM'd
 * non-collision con head ORFANA (nessun check vitest, lasciata da un rebase
 * precedente) deve essere SANATA (dispatch tests), NON ri-rebasata — altrimenti
 * ogni tick orfanizza una nuova head e il vitest non chiude mai verde
 * (#2415 rebasata 3× in 15min su main caldo, mai mergiata).
 *
 * `collisionRisk` (bool grezzo dalla label) è stato sostituito da
 * `collisionBlocked` (#6039): il chiamante lo calcola col gate PRECISO di
 * auto-merge-eval (collisionGateDecision), non più "la label è presente" —
 * la funzione pura qui sotto resta agnostica di COME collisionBlocked è
 * derivato, testa solo che, dato il booleano, la decisione sia corretta.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  rebaseActionForLgtmPr,
  reviewerReviewOnHead,
  staleReviewAction,
} from '../scripts/ci/pr-autorebase.mjs';

const AUTOREBASE_SOURCE = readFileSync(
  new URL('../scripts/ci/pr-autorebase.mjs', import.meta.url),
  'utf8',
);

describe('rebaseActionForLgtmPr (#2415 rebase-thrash livelock guard)', () => {
  it('REGRESSIONE #2415: LGTM non-collision + head orfana (no vitest) → heal, NON rebase', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionBlocked: false, vitestConclusion: '', hasVitestCheck: false,
    })).toBe('heal');
  });

  it('LGTM non-collision + vitest success presente → skip (auto-merge la mergia behind)', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionBlocked: false, vitestConclusion: 'success', hasVitestCheck: true,
    })).toBe('skip');
  });

  it('LGTM non-collision + vitest pending ma check PRESENTE (shard in corso) → skip (non orfana)', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionBlocked: false, vitestConclusion: '', hasVitestCheck: true,
    })).toBe('skip');
  });

  it('vitest=failure → rebase (eredita i fix di main)', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionBlocked: false, vitestConclusion: 'failure', hasVitestCheck: true,
    })).toBe('rebase');
  });

  it('REGRESSIONE #6039: collision-risk ma gate collisione NON blocca (peer inclusi/nessun peer mergiato) → NON forzare rebase anche con vitest verde', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionBlocked: false, vitestConclusion: 'success', hasVitestCheck: true,
    })).toBe('skip');
  });

  it('collision-risk + gate collisione BLOCCA (peer mergiato non incluso in head) → rebase', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionBlocked: true, vitestConclusion: 'success', hasVitestCheck: true,
    })).toBe('rebase');
  });

  it('collision-risk bloccato + head orfana → rebase (NON heal)', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionBlocked: true, vitestConclusion: '', hasVitestCheck: false,
    })).toBe('rebase');
  });

  it('REGRESSIONE #10580: LGTM + solo il review gate rosso su un verdetto fresco → reopen sulla stessa HEAD, non merge di main', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionBlocked: false, vitestConclusion: 'failure', hasVitestCheck: true, reviewGateOnly: true,
    })).toBe('reopen');
  });

  it('reviewGateOnly non prevale su una collisione reale né su un rosso dei test', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionBlocked: true, vitestConclusion: 'failure', hasVitestCheck: true, reviewGateOnly: true,
    })).toBe('rebase');
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionBlocked: false, vitestConclusion: 'failure', hasVitestCheck: true, reviewGateOnly: false,
    })).toBe('rebase');
    expect(rebaseActionForLgtmPr({
      lgtm: false, collisionBlocked: false, vitestConclusion: 'failure', hasVitestCheck: true, reviewGateOnly: true,
    })).toBe('rebase');
  });

  it('il reopen passa dal breaker e dalle guardie in volo prima di ogni merge', () => {
    const processPr = AUTOREBASE_SOURCE.slice(AUTOREBASE_SOURCE.indexOf('async function processPR('));
    const inFlight = processPr.indexOf('const inFlight = testsRunInFlightOnHead(');
    const reopen = processPr.indexOf("if (action === 'reopen') {");
    const merge = processPr.indexOf("git(['merge', '--no-edit', 'origin/main']", reopen);
    expect(inFlight).toBeGreaterThan(-1);
    expect(reopen).toBeGreaterThan(inFlight);
    expect(merge).toBeGreaterThan(reopen);
    expect(processPr.slice(reopen, merge)).toContain('guardedReopen(num, head)');
    const predicate = AUTOREBASE_SOURCE.slice(
      AUTOREBASE_SOURCE.indexOf('function reviewGateRedOnFreshVerdict('),
      AUTOREBASE_SOURCE.indexOf('function readReopenBudgetBody('),
    );
    expect(predicate).toContain('reviewSkippedByGuard(steps) || reviewAbortedWithoutVerdict(steps)');
    expect(predicate).toContain('prior.reviewGateUsed');
  });

  it('non-LGTM → rebase (non near-merge-as-is)', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: false, collisionBlocked: false, vitestConclusion: 'success', hasVitestCheck: true,
    })).toBe('rebase');
  });
});

describe('staleReviewAction (merge di main solo quando serve)', () => {
  it('stale-review senza review → retrigger sulla stessa head', () => {
    expect(staleReviewAction({
      staleReview: true,
      lgtm: false,
      hasCurrentClaudeReview: false,
      stuckRed: false,
      collisionRisk: false,
    })).toBe('retrigger');
  });

  it('stale-review con review esistente → attende il fixer, niente merge', () => {
    expect(staleReviewAction({
      staleReview: true,
      lgtm: false,
      hasCurrentClaudeReview: true,
      stuckRed: false,
      collisionRisk: false,
    })).toBe('wait');
  });

  it('REGRESSIONE #10467: un tests.yml diverso da main non è un motivo di merge (AGENTS.md «MAI merge per profilassi»)', () => {
    // Il vecchio parametro `workflowValidationDrift` scattava su ogni PR nata
    // prima dell'ultima modifica di tests.yml: cinque merge di main in otto
    // ore, ogni HEAD nuova azzerava il round cap del 🔴-fixer.
    expect(staleReviewAction({
      staleReview: true,
      lgtm: false,
      workflowValidationDrift: true,
      hasCurrentClaudeReview: true,
      stuckRed: false,
      collisionRisk: false,
    } as Parameters<typeof staleReviewAction>[0])).toBe('wait');
  });

  it("stuck-red → rebase (l'unico caso che il merge ripara)", () => {
    expect(staleReviewAction({
      staleReview: true,
      lgtm: false,
      hasCurrentClaudeReview: false,
      stuckRed: true,
      collisionRisk: false,
    })).toBe('rebase');
  });

  it('senza stale-review o con collision-risk lascia il percorso esistente', () => {
    expect(staleReviewAction({
      staleReview: false,
      lgtm: false,
      hasCurrentClaudeReview: false,
      stuckRed: false,
      collisionRisk: false,
    })).toBe('continue');
    expect(staleReviewAction({
      staleReview: true,
      lgtm: false,
      hasCurrentClaudeReview: false,
      stuckRed: false,
      collisionRisk: true,
    })).toBe('continue');
  });
});

describe('reviewerReviewOnHead (stale-review exact-head)', () => {
  it('ignora una review del commit precedente', () => {
    expect(reviewerReviewOnHead([
      { user: { login: 'claude[bot]' }, commit_id: 'old-head' },
    ], 'current-head')).toBe(false);
  });

  it('accetta solo una review del bot sulla HEAD corrente', () => {
    expect(reviewerReviewOnHead([
      { user: { login: 'frontaliere-automation[bot]' }, commit_id: 'current-head' },
    ], 'current-head')).toBe(true);
    expect(reviewerReviewOnHead([
      { user: { login: 'human' }, commit_id: 'current-head' },
    ], 'current-head')).toBe(false);
  });

  it('su errore API resta fail-closed', () => {
    expect(reviewerReviewOnHead(null, 'current-head')).toBe(true);
  });
});

describe('integrazione stale-review → merge', () => {
  it('non confronta più il workflow con main prima di decidere il merge', () => {
    expect(AUTOREBASE_SOURCE).not.toContain('hasReviewWorkflowValidationDrift');
    expect(AUTOREBASE_SOURCE).not.toContain('workflowValidationDrift');
    const decision = AUTOREBASE_SOURCE.indexOf('const staleAction = staleReviewAction({');
    const merge = AUTOREBASE_SOURCE.indexOf(
      "git(['merge', '--no-edit', 'origin/main']",
      decision,
    );
    expect(decision).toBeGreaterThanOrEqual(0);
    expect(merge).toBeGreaterThan(decision);
    expect(AUTOREBASE_SOURCE).toContain('stale-review senza review sulla HEAD');
  });
});
