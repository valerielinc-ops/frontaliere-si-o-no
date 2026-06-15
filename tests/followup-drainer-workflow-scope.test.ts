/**
 * followup-drainer — detectWorkflowScoped pre-flight (#1724).
 *
 * `fix-outcome:blocked-workflows-scope` ricorre 13×/14gg: ogni occorrenza è una
 * follow-up distinta il cui fix tocca solo `.github/workflows/**`, che il token
 * GitHub App di issue-fix non può pushare. Il drainer la parka già a posteriori
 * (NON_RETRYABLE) ma solo dopo un run Claude da ~1M token. Questo detector la
 * intercetta PRIMA della promozione. È CONSERVATIVO (bias a promuovere): scatta
 * solo quando il body cita workflow path E nessun file di codice non-workflow.
 */
import { describe, it, expect } from 'vitest';
import { detectWorkflowScoped } from '../scripts/ci/followup-drainer.mjs';

describe('detectWorkflowScoped — scoped (park preemptivo)', () => {
  it('rileva il body reale #1607 (Suggested action: editare post-deploy-validate-dist.yml)', () => {
    const body = [
      '### 1. Guard rehydrate controlla solo `dist/$loc`',
      'Original text: …`deploy.yml:L1148`…',
      'Suggested action: in `.github/workflows/post-deploy-validate-dist.yml`, allargare il guard',
    ].join('\n');
    expect(detectWorkflowScoped(body)).toBe(true);
  });

  it('rileva un bare workflow .yml senza altri path di codice', () => {
    expect(detectWorkflowScoped('Fix the rate-limit in orchestrate-crawlers.yml dispatch loop')).toBe(true);
  });
});

describe('detectWorkflowScoped — NON scoped (promuovi)', () => {
  it('non scatta se cita un file di codice non-workflow (il fix può vivere lì)', () => {
    // body reale #1711: il fix è in build-plugins/shared/criticalCss.ts
    expect(
      detectWorkflowScoped('dedupe criticalCSS into `build-plugins/shared/criticalCss.ts` shared module'),
    ).toBe(false);
  });

  it('non scatta se cita workflow .yml MA anche un path di codice (ambiguo → promuovi)', () => {
    expect(
      detectWorkflowScoped('deploy.yml calls `scripts/ci/foo.mjs` which has the bug'),
    ).toBe(false);
  });

  it('non scatta senza alcun riferimento a workflow', () => {
    expect(detectWorkflowScoped('Generic prose follow-up with no file paths at all')).toBe(false);
  });

  it('non scatta su un .yml di config non-workflow (lighthouserc.yml)', () => {
    expect(detectWorkflowScoped('bump CLS budget in lighthouserc.yml')).toBe(false);
  });

  it('gestisce input vuoto/null senza throw', () => {
    expect(detectWorkflowScoped('')).toBe(false);
    expect(detectWorkflowScoped(undefined as unknown as string)).toBe(false);
  });
});
