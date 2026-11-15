/**
 * F9 — l'invariante «una HEAD nuova non passa il required check
 * `vitest (unit + integration)` senza LGTM su quella HEAD» NON basta a
 * togliere la revoca dell'auto-merge nativo al cambio di HEAD: il gate nativo
 * nega anche per fatti che il required check non valuta, quindi un opt-in
 * persistente (sopravvive al `synchronize`) lasciato in piedi farebbe mergiare
 * a GitHub una HEAD che il gate avrebbe negato.
 *
 * Il test fissa il controesempio, così chiunque riapra F9 parte da qui:
 * se un giorno il required check valuterà lo snapshot dei file della PR e la
 * policy di rischio, il primo test fallirà e la revoca si potrà restringere.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { revalidateNativeAutoMerge } from '../scripts/ci/native-automerge-gate.mjs';
import { reviewInputMarker, reviewInputRevisionFromBody } from '../scripts/ci/lib/review-input-revision.mjs';

const NEW_HEAD = 'c'.repeat(40);
const REVISION = reviewInputRevisionFromBody('');
const lgtmOnNewHead = {
  id: 7,
  user: { type: 'Bot', login: 'claude[bot]' },
  state: 'COMMENTED',
  body: `${reviewInputMarker(REVISION)}\n## Findings (Important: 0, Nit: 0)\n\n## LGTM`,
  commit_id: NEW_HEAD,
  submitted_at: '2026-11-14T10:00:00Z',
};
const requiredCheckGreenOnNewHead = {
  id: 202,
  name: 'vitest (unit + integration)',
  head_sha: NEW_HEAD,
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-11-14T10:00:00Z',
  completed_at: '2026-11-14T10:01:00Z',
};
const persistedOptIn = {
  state: 'OPEN',
  isDraft: false,
  baseRefName: 'main',
  title: 'Safe change',
  body: '',
  labels: [],
  headRefOid: NEW_HEAD,
  autoMergeRequest: { enabledAt: '2026-11-14T09:00:00Z' },
};

describe('F9: il required check non implica il gate nativo sulla HEAD nuova', () => {
  it('LGTM + required check verdi sulla HEAD nuova, ma snapshot file incompleto: il gate REVOCA', () => {
    const decision = revalidateNativeAutoMerge({
      pr: { ...persistedOptIn, changedFiles: ['scripts/x.mjs'], changedFilesComplete: false },
      reviews: [lgtmOnNewHead],
      checkRuns: [requiredCheckGreenOnNewHead],
    });
    expect(decision).toMatchObject({ allow: false, action: 'revoke' });
    expect(decision.reason).toContain('policy PR non verificabile');
  });

  it('con snapshot completo la stessa coppia review/check mantiene l\'opt-in (nessun falso positivo)', () => {
    expect(revalidateNativeAutoMerge({
      pr: { ...persistedOptIn, changedFiles: ['scripts/x.mjs'], changedFilesComplete: true },
      reviews: [lgtmOnNewHead],
      checkRuns: [requiredCheckGreenOnNewHead],
    })).toMatchObject({ allow: true, action: 'retain' });
  });

  it('il review gate del job required non importa la policy di rischio del gate nativo', () => {
    // Il required check esegue `review-gate.mjs`: se un giorno valutasse
    // anche lo snapshot dei file/la policy di rischio, il primo test sopra
    // smetterebbe di essere un controesempio e la revoca si potrebbe restringere.
    const gate = readFileSync(new URL('../scripts/ci/review-gate.mjs', import.meta.url), 'utf8');
    expect(gate).not.toContain('automation-risk-policy');
    expect(gate).not.toContain('classifyAutomationRisk');
  });
});
