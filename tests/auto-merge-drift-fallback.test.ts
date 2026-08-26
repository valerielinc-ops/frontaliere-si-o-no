/**
 * auto-merge-eval — drift-fallback: gate puri (senza gh) che decidono se una PR
 * il cui reviewer Claude NON ha potuto girare (modifica `tests.yml` →
 * workflow-validation 401) può comunque auto-mergiare su gate deterministici.
 * Rimuove l'unico merge MANUALE residuo. Vedi REVIEW_WORKFLOW_DRIFT_FILES.
 */
import { describe, it, expect } from 'vitest';
import { isReviewWorkflowDriftPR, isTrustedDriftAuthor, prBodyContractOk } from '../scripts/ci/auto-merge-eval.mjs';
import { isReviewerBot } from '../scripts/ci/lib/constants.mjs';
import { REVIEW_WORKFLOW_DRIFT_FILES } from '../scripts/ci/lib/constants.mjs';

describe('isReviewerBot', () => {
  it('riconosce sia Claude sia la GitHub App che pubblica la review', () => {
    expect(isReviewerBot({ type: 'Bot', login: 'claude[bot]' })).toBe(true);
    expect(isReviewerBot({ type: 'Bot', login: 'frontaliere-automation[bot]' })).toBe(true);
  });

  it('non accetta bot esterni o utenti con login simile', () => {
    expect(isReviewerBot({ type: 'Bot', login: 'frontaliere-automation-evil[bot]' })).toBe(false);
    expect(isReviewerBot({ type: 'User', login: 'frontaliere-automation[bot]' })).toBe(false);
  });
});

describe('isReviewWorkflowDriftPR', () => {
  it('true quando la PR modifica tests.yml', () => {
    expect(isReviewWorkflowDriftPR(['.github/workflows/tests.yml'])).toBe(true);
    expect(isReviewWorkflowDriftPR(['scripts/foo.mjs', '.github/workflows/tests.yml'])).toBe(true);
  });

  it('false per PR che NON toccano un drift-file (anche altri workflow/review files)', () => {
    expect(isReviewWorkflowDriftPR(['scripts/ci/auto-merge-eval.mjs'])).toBe(false);
    // Questi NON driftano il reviewer → percorso ## LGTM normale, niente fallback.
    expect(isReviewWorkflowDriftPR(['.github/workflows/auto-merge-on-lgtm.yml'])).toBe(false);
    expect(isReviewWorkflowDriftPR(['.github/workflows/post-merge-followup.yml'])).toBe(false);
    expect(isReviewWorkflowDriftPR(['REVIEW.md'])).toBe(false);
  });

  it('robusto a input non-array', () => {
    expect(isReviewWorkflowDriftPR(undefined as unknown as string[])).toBe(false);
    expect(isReviewWorkflowDriftPR(null as unknown as string[])).toBe(false);
  });

  it('la lista drift è MINIMA (solo tests.yml) — superficie no-review contenuta', () => {
    expect(REVIEW_WORKFLOW_DRIFT_FILES).toEqual(['.github/workflows/tests.yml']);
  });
});

describe('isTrustedDriftAuthor', () => {
  it('true per owner/membro/collaboratore del repo', () => {
    expect(isTrustedDriftAuthor({ assoc: 'OWNER', login: 'valerielinc-ops', type: 'User' })).toBe(true);
    expect(isTrustedDriftAuthor({ assoc: 'MEMBER', login: 'x', type: 'User' })).toBe(true);
    expect(isTrustedDriftAuthor({ assoc: 'COLLABORATOR', login: 'x', type: 'User' })).toBe(true);
  });

  it('true per i bot di automazione interni', () => {
    expect(isTrustedDriftAuthor({ assoc: 'NONE', login: 'claude', type: 'Bot' })).toBe(true);
    expect(isTrustedDriftAuthor({ assoc: 'CONTRIBUTOR', login: 'github-actions', type: 'Bot' })).toBe(true);
    // The frontaliere-automation App (matched by EXACT slug, assoc is NONE for apps).
    expect(isTrustedDriftAuthor({ assoc: 'NONE', login: 'frontaliere-automation[bot]', type: 'Bot' })).toBe(true);
  });

  it('false per contributor/none umani e bot non in allowlist', () => {
    expect(isTrustedDriftAuthor({ assoc: 'CONTRIBUTOR', login: 'random', type: 'User' })).toBe(false);
    expect(isTrustedDriftAuthor({ assoc: 'NONE', login: 'random', type: 'User' })).toBe(false);
    // un bot esterno NON in allowlist non passa
    expect(isTrustedDriftAuthor({ assoc: 'NONE', login: 'dependabot', type: 'Bot' })).toBe(false);
    // exact-slug match: a look-alike app slug must NOT pass (no broad widening)
    expect(isTrustedDriftAuthor({ assoc: 'NONE', login: 'frontaliere-automation-evil[bot]', type: 'Bot' })).toBe(false);
  });

  it('false per meta mancante', () => {
    expect(isTrustedDriftAuthor(null)).toBe(false);
    expect(isTrustedDriftAuthor(undefined)).toBe(false);
  });
});

describe('prBodyContractOk (valutato dal body, non dalla sticky)', () => {
  const goodBody = [
    '## Implementato',
    '- fa la cosa',
    '',
    '## Non implementato (ancora)',
    '- niente altro',
  ].join('\n');

  it('true quando entrambi gli header ci sono e nessun Closes multi-issue', () => {
    expect(prBodyContractOk(goodBody)).toBe(true);
    // tollera testo in coda all\'header e il livello ###
    expect(prBodyContractOk('### Implementato\nx\n### Non implementato (ancora)\ny')).toBe(true);
  });

  it('false se manca uno degli header obbligatori', () => {
    expect(prBodyContractOk('## Implementato\n- x')).toBe(false);
    expect(prBodyContractOk('## Non implementato\n- x')).toBe(false);
    expect(prBodyContractOk('## Fix\n- x\n## Verify\n- y')).toBe(false);
    expect(prBodyContractOk('')).toBe(false);
  });

  it('false su Closes multi-issue su una riga (anche con header presenti)', () => {
    expect(prBodyContractOk(`${goodBody}\n\nCloses #12 #34`)).toBe(false);
  });

  it('true con Closes singolo per riga (forma corretta)', () => {
    expect(prBodyContractOk(`${goodBody}\n\nCloses #12\nCloses #34`)).toBe(true);
  });
});
