import { describe, it, expect } from 'vitest';
import {
  extractNonImplementedItems,
  isCandidateItem,
  reviewerMarkerLines,
  selectReviewerBody,
  hasCandidates,
} from '../scripts/ci/followup-has-candidates.mjs';

// No-op pre-gate for post-merge-followup: skip the Claude triage run only when a PR
// has NOTHING to triage. PROCEED-SAFE — any doubt yields a candidate (run Claude).
// These cover the pure decision core; the gh I/O wrapper is exercised live.

describe('extractNonImplementedItems', () => {
  it('pulls bullet items under the section up to the next heading', () => {
    const body = [
      '## Implementato',
      '- cache opt-in',
      '',
      '## Non implementato (ancora)',
      '- Fronte2: re-review scoped (PR concatenata)',
      '- batching issue-fix',
      '',
      '## Note',
      '- irrelevant',
    ].join('\n');
    expect(extractNonImplementedItems(body)).toEqual([
      'Fronte2: re-review scoped (PR concatenata)',
      'batching issue-fix',
    ]);
  });

  it('returns [] when the section is absent', () => {
    expect(extractNonImplementedItems('## Implementato\n- x')).toEqual([]);
  });

  it('returns the literal "Nessuno" line (filtered later by isCandidateItem)', () => {
    const body = '## Non implementato (ancora)\nNessuno\n';
    expect(extractNonImplementedItems(body)).toEqual(['Nessuno']);
  });
});

describe('isCandidateItem', () => {
  it('treats empty markers as non-candidates', () => {
    for (const s of ['Nessuno', 'none', 'N/A', 'TBD', '—', '']) {
      expect(isCandidateItem(s)).toBe(false);
    }
  });

  it('drops hard-excluded classes (live-verify / missing-test / churn)', () => {
    expect(isCandidateItem('Verifica live post-deploy che la pagina renda 200')).toBe(false);
    expect(isCandidateItem('Aggiungere un test per il nuovo gate')).toBe(false);
    expect(isCandidateItem('missing test for the helper')).toBe(false);
    expect(isCandidateItem('de-rot dei commenti / nit puro, non funnel-critical')).toBe(false);
  });

  it('keeps a real funnel-relevant scope item', () => {
    expect(isCandidateItem('Estendere il fix ai crawler sibling update-*.mjs')).toBe(true);
    expect(isCandidateItem('Backfill dei salari per-cantone non ancora eseguito')).toBe(true);
  });
});

describe('reviewerMarkerLines', () => {
  it('counts 🟡 and ❓ lines, ignoring hard-excluded ones', () => {
    const review = [
      '## LGTM',
      '🟡 Considera di estrarre la regex condivisa in un modulo',
      '❓ È intenzionale che il cap sia 500?',
      '🟡 manca un test per questo ramo', // hard-excluded (missing-test)
    ].join('\n');
    expect(reviewerMarkerLines(review)).toHaveLength(2);
  });

  it('returns [] for a clean LGTM with no markers', () => {
    expect(reviewerMarkerLines('## LGTM\nTutto a posto, nessun finding.')).toEqual([]);
  });
});

describe('selectReviewerBody', () => {
  // Regression for the 🔴 caught in review: the reviewer posts as `claude[bot]`,
  // not `github-actions[bot]`. Filtering on the wrong login killed the 🟡/❓ branch.
  it('picks the claude[bot] review, not github-actions[bot]', () => {
    const reviews = [
      { user: { login: 'github-actions[bot]', type: 'Bot' }, body: 'CI summary' },
      { user: { login: 'claude[bot]', type: 'Bot' }, body: '## LGTM\n🟡 nit' },
    ];
    expect(selectReviewerBody(reviews)).toBe('## LGTM\n🟡 nit');
  });

  it('returns the LATEST claude review when there are several', () => {
    const reviews = [
      { user: { login: 'claude[bot]', type: 'Bot' }, body: 'round 1: 🔴 Important' },
      { user: { login: 'claude[bot]', type: 'Bot' }, body: 'round 2: ## LGTM' },
    ];
    expect(selectReviewerBody(reviews)).toBe('round 2: ## LGTM');
  });

  it('ignores human reviews and returns "" when no bot review exists', () => {
    expect(selectReviewerBody([{ user: { login: 'someone', type: 'User' }, body: '🟡 manual' }])).toBe('');
  });

  it('proceed-safe on non-array / empty input', () => {
    expect(selectReviewerBody(undefined as unknown as [])).toBe('');
    expect(selectReviewerBody([])).toBe('');
  });
});

describe('hasCandidates', () => {
  it('false when section is Nessuno and review is a clean LGTM', () => {
    expect(hasCandidates({
      body: '## Implementato\n- x\n## Non implementato (ancora)\nNessuno\n',
      reviewBody: '## LGTM\nNessun finding.',
    })).toBe(false);
  });

  it('false when all NI items are hard-excluded and no reviewer markers', () => {
    expect(hasCandidates({
      body: '## Non implementato (ancora)\n- Verifica live post-deploy\n- aggiungere coverage\n',
      reviewBody: '## LGTM',
    })).toBe(false);
  });

  it('true when a real NI item exists', () => {
    expect(hasCandidates({
      body: '## Non implementato (ancora)\n- Estendere ai sibling update-*.mjs\n',
      reviewBody: '## LGTM',
    })).toBe(true);
  });

  it('true when the reviewer left a 🟡/❓ even with empty NI', () => {
    expect(hasCandidates({
      body: '## Non implementato (ancora)\nNessuno\n',
      reviewBody: '## LGTM\n🟡 Valuta un indice composto qui',
    })).toBe(true);
  });

  it('true (proceed-safe) on empty/garbled input', () => {
    expect(hasCandidates({ body: '', reviewBody: '' })).toBe(false); // genuinely nothing
    expect(hasCandidates({ body: '## Non implementato (ancora)\n- random scope work\n', reviewBody: '' })).toBe(true);
  });
});
