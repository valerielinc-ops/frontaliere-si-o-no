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
  reviewWorkflowHasDrift,
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

  it('non-LGTM → rebase (non near-merge-as-is)', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: false, collisionBlocked: false, vitestConclusion: 'success', hasVitestCheck: true,
    })).toBe('rebase');
  });
});

describe('staleReviewAction (merge di main solo quando serve)', () => {
  it('stale-review senza drift e senza review → retrigger sulla stessa head', () => {
    expect(staleReviewAction({
      staleReview: true,
      lgtm: false,
      workflowValidationDrift: false,
      hasCurrentClaudeReview: false,
      stuckRed: false,
      collisionRisk: false,
    })).toBe('retrigger');
  });

  it('stale-review senza drift con review esistente → attende il fixer, niente merge', () => {
    expect(staleReviewAction({
      staleReview: true,
      lgtm: false,
      workflowValidationDrift: false,
      hasCurrentClaudeReview: true,
      stuckRed: false,
      collisionRisk: false,
    })).toBe('wait');
  });

  it('stale-review con workflow modificato rispetto a main → rebase', () => {
    expect(staleReviewAction({
      staleReview: true,
      lgtm: false,
      workflowValidationDrift: true,
      hasCurrentClaudeReview: false,
      stuckRed: false,
      collisionRisk: false,
    })).toBe('rebase');
  });

  it("stuck-red prevale sull'assenza di drift → rebase", () => {
    expect(staleReviewAction({
      staleReview: true,
      lgtm: false,
      workflowValidationDrift: false,
      hasCurrentClaudeReview: false,
      stuckRed: true,
      collisionRisk: false,
    })).toBe('rebase');
  });

  it('senza stale-review o con collision-risk lascia il percorso esistente', () => {
    expect(staleReviewAction({
      staleReview: false,
      lgtm: false,
      workflowValidationDrift: false,
      hasCurrentClaudeReview: false,
      stuckRed: false,
      collisionRisk: false,
    })).toBe('continue');
    expect(staleReviewAction({
      staleReview: true,
      lgtm: false,
      workflowValidationDrift: false,
      hasCurrentClaudeReview: false,
      stuckRed: false,
      collisionRisk: true,
    })).toBe('continue');
  });
});

describe('reviewWorkflowHasDrift (workflow-validation 401)', () => {
  const same = {
    '.github/workflows/tests.yml': { exists: true, oid: 'tests-v1' },
    '.github/workflows/pr-review-loop.yml': { exists: false, oid: null },
  };

  it('non segnala drift per entry byte-identiche e file storico assente su entrambi i ref', () => {
    expect(reviewWorkflowHasDrift(same, structuredClone(same))).toBe(false);
  });

  it('segnala una modifica byte-level a tests.yml', () => {
    expect(reviewWorkflowHasDrift(same, {
      ...same,
      '.github/workflows/tests.yml': { exists: true, oid: 'tests-v2' },
    })).toBe(true);
  });

  it('segnala aggiunta o rimozione del workflow storico', () => {
    expect(reviewWorkflowHasDrift(same, {
      ...same,
      '.github/workflows/pr-review-loop.yml': { exists: true, oid: 'legacy-v1' },
    })).toBe(true);
  });

  it('su entry illeggibile resta fail-closed e richiede il merge', () => {
    expect(reviewWorkflowHasDrift(same, {
      ...same,
      '.github/workflows/tests.yml': null,
    })).toBe(true);
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
  it('chiama il detector byte-level prima del merge di origin/main', () => {
    const detector = AUTOREBASE_SOURCE.indexOf('hasReviewWorkflowValidationDrift(head)');
    const merge = AUTOREBASE_SOURCE.indexOf(
      "git(['merge', '--no-edit', 'origin/main']",
      detector,
    );
    expect(detector).toBeGreaterThanOrEqual(0);
    expect(merge).toBeGreaterThan(detector);
    expect(AUTOREBASE_SOURCE).toContain('stale-review senza drift del workflow e senza review');
  });
});
