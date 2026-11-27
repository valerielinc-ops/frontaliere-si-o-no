/**
 * followup-drainer — startup failure su ramo non-main (caso #20294-#20319).
 *
 * Una issue «Workflow failure senza job» con `**Ref:**` diverso da `main` e' un
 * falso allarme di un ramo di PR: il drain la parcheggia prima della promozione
 * (nessun `agent:fix`, nessun `fu-attempt`). Su `main` resta lavorabile.
 * Dati di test inventati.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  detectBranchStartupFailure,
  isIssueGroupable,
} from '../scripts/ci/followup-drainer.mjs';

const bodyFor = (ref: string) => [
  '**Workflow:** Example Group 07 logic (reusable workflow)',
  '',
  '## Workflow failure senza job',
  '',
  '**Run:** https://github.com/example-org/example-repo/actions/runs/1000001',
  '**Conclusione:** `failure`',
  '**Trigger:** push',
  `**Ref:** ${ref}`,
  '**Job restituiti da Actions:** 0',
  '',
  'La run e\' fallita prima che Actions rendesse disponibile un job.',
].join('\n');

describe('detectBranchStartupFailure', () => {
  it('ramo di PR → ritorna il ramo (park, nessun tentativo)', () => {
    expect(detectBranchStartupFailure(bodyFor('fix/issue-1234'))).toBe('fix/issue-1234');
  });

  it('refs/heads/<ramo> → ritorna il ramo senza prefisso', () => {
    expect(detectBranchStartupFailure(bodyFor('refs/heads/feat/example'))).toBe('feat/example');
  });

  it('main → null (resta lavorabile come oggi)', () => {
    expect(detectBranchStartupFailure(bodyFor('main'))).toBeNull();
    expect(detectBranchStartupFailure(bodyFor('refs/heads/main'))).toBeNull();
  });

  it('body non di startup failure o Ref assente → null (bias a promuovere)', () => {
    expect(detectBranchStartupFailure('**Ref:** fix/issue-1234\nAltro difetto reale')).toBeNull();
    expect(detectBranchStartupFailure('## Workflow failure senza job\n\nnessun ref')).toBeNull();
    expect(detectBranchStartupFailure('')).toBeNull();
    expect(detectBranchStartupFailure(undefined as unknown as string)).toBeNull();
  });
});

describe('isIssueGroupable — startup failure', () => {
  const issue = (ref: string) => ({
    number: 99001,
    title: 'CI Failure (push): Example Group 07 logic (reusable workflow)',
    body: bodyFor(ref),
    labels: [{ name: 'bug' }, { name: 'ci-startup-failure' }, { name: 'agent:fix-queued' }],
  });

  it('ramo non-main → mai raggruppabile con altre issue', () => {
    expect(isIssueGroupable(issue('fix/issue-1234'))).toBe(false);
  });

  it('main → il rilevatore non la esclude', () => {
    expect(detectBranchStartupFailure(issue('main').body)).toBeNull();
  });
});

describe('DRAIN wiring', () => {
  const src = readFileSync(new URL('../scripts/ci/followup-drainer.mjs', import.meta.url), 'utf8');
  const at = src.indexOf('const startupBranch = detectBranchStartupFailure(body);');
  const block = src.slice(at, src.indexOf('Check: epic-tracker', at));

  it('il park avviene prima della promozione e non tocca fu-attempt', () => {
    expect(at).toBeGreaterThan(0);
    expect(block).toContain('deferAutomationIssue(cand.number');
    expect(block).toContain('add: [LBL_PARKED]');
    expect(block).not.toMatch(/add:\s*\[[^\]]*LBL_FIX/);
    expect(block).not.toMatch(/attempt\s*\+\+|bumpAttempt|attemptLabel/i);
    expect(at).toBeLessThan(src.indexOf('detectEpicTracker(cand.title, body)'));
  });
});
