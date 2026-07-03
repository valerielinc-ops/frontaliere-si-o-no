/**
 * Lock the two-tier auto-close decision of reconcile-followups.mjs
 * (lever 1: drain the maybe-resolved pile deterministically without losing quality).
 *
 * The matcher (`detectAlreadyResolved`) is tested separately in
 * followup-resolution-match.test.ts; here we only lock the TIER policy: when a
 * deterministically-resolved follow-up flips to flag vs auto-close vs held, including
 * the human-objection and multi-item-aggregate safety vetoes.
 */
import { describe, it, expect } from 'vitest';
import { isAggregateTitle, decideReconcileAction, isStrongAutoCloseEvidence } from '../scripts/ci/reconcile-followups.mjs';

describe('isAggregateTitle — multi-item follow-ups never auto-close', () => {
  it('flags N≥2 "item(s)" titles as aggregate', () => {
    expect(isAggregateTitle('follow-up(#1674): 3 item deferred — fix(seo): ...')).toBe(true);
    expect(isAggregateTitle('follow-up(#1651): 2 items deferred — fix(data): ...')).toBe(true);
  });
  it('treats single-item / count-less titles as non-aggregate (eligible)', () => {
    expect(isAggregateTitle('follow-up(#1685): 1 item deferred — perf(...): ...')).toBe(false);
    expect(isAggregateTitle('fix(crawlers): extract shared assertJsonListShape guard')).toBe(false);
    expect(isAggregateTitle('')).toBe(false);
  });
  it('flags sweep/batch/bulk titles as aggregate even without an "N items" count (#1826 class)', () => {
    expect(isAggregateTitle('Sweep: ~30 crawlers need shared fetchHtml')).toBe(true);
    expect(isAggregateTitle('follow-up(#1826): batch-fix all parser selectors')).toBe(true);
    expect(isAggregateTitle('chore: bulk migrate job slugs')).toBe(true);
    // word-boundary: substrings inside unrelated words don't trigger
    expect(isAggregateTitle('fix: swept the floor reference')).toBe(false);
  });
  it('explicit "1 item deferred" wins over an ordinary "batch"/"sweep"/"bulk" word in the same title — count is authoritative, no keyword fallback (#3378)', () => {
    expect(isAggregateTitle(
      'follow-up(#3371): 1 item deferred — fix(job-alerts): batch backfill re-checks tier-3 before tier-4 URL fallback',
    )).toBe(false);
  });
});

describe('isStrongAutoCloseEvidence — weak single tokens never auto-close', () => {
  it('≥2 distinct matched tokens → strong', () => {
    expect(isStrongAutoCloseEvidence(['meta.model', 'CDN_BASE()'])).toBe(true);
  });
  it('single RICH token (≥2 punctuation = real expression) → strong', () => {
    expect(isStrongAutoCloseEvidence(['displayCount = page === 1 ? a : b'])).toBe(true);
    expect(isStrongAutoCloseEvidence(['foo(bar).baz'])).toBe(true); // ( ) . → 3 punct
  });
  it('single weak token (≤1 punctuation: bare dot-member / single op) → NOT strong (held for human)', () => {
    expect(isStrongAutoCloseEvidence(['meta.model'])).toBe(false); // 1 dot
    expect(isStrongAutoCloseEvidence(['injected > 0'])).toBe(false); // 1 op
    expect(isStrongAutoCloseEvidence(['window.__CDN_DATA_BASE__'])).toBe(false); // 1 dot (underscores aren't punct)
  });
  it('empty → not strong', () => {
    expect(isStrongAutoCloseEvidence([])).toBe(false);
    expect(isStrongAutoCloseEvidence(undefined)).toBe(false);
  });
});

describe('decideReconcileAction — two-tier, double-confirm-across-time', () => {
  const base = { resolved: true, hasMaybeResolved: false, hasPriorFlag: false, isAggregate: false, blocked: false, strongEvidence: true };

  it('does nothing when not resolved', () => {
    expect(decideReconcileAction({ ...base, resolved: false })).toBe('none');
  });

  it('first detection → flag (grace window), never closes on first sight', () => {
    expect(decideReconcileAction({ ...base })).toBe('flag');
  });

  it('second confirmation (prior flag + label still present, eligible) → close', () => {
    expect(decideReconcileAction({ ...base, hasPriorFlag: true, hasMaybeResolved: true })).toBe('close');
  });

  it('human objection (we flagged before, label since removed) → none', () => {
    expect(decideReconcileAction({ ...base, hasPriorFlag: true, hasMaybeResolved: false })).toBe('none');
  });

  it('multi-item aggregate never auto-closes (held after first flag)', () => {
    expect(decideReconcileAction({ ...base, isAggregate: true })).toBe('flag');
    expect(decideReconcileAction({ ...base, isAggregate: true, hasPriorFlag: true, hasMaybeResolved: true })).toBe('none');
  });

  it('keep-open / strategic label vetoes auto-close (held after first flag)', () => {
    expect(decideReconcileAction({ ...base, blocked: true })).toBe('flag');
    expect(decideReconcileAction({ ...base, blocked: true, hasPriorFlag: true, hasMaybeResolved: true })).toBe('none');
  });

  it('NO_AUTOCLOSE escape hatch forces tier-1 only', () => {
    expect(decideReconcileAction({ ...base, noAutoclose: true, hasPriorFlag: true, hasMaybeResolved: true })).toBe('none');
    expect(decideReconcileAction({ ...base, noAutoclose: true })).toBe('flag');
  });

  it('label present but no prior flag from us → flag (gets its own grace cycle, not an instant close)', () => {
    expect(decideReconcileAction({ ...base, hasMaybeResolved: true, hasPriorFlag: false })).toBe('flag');
  });

  it('weak evidence never auto-closes: first seen → flag, already flagged → held (none)', () => {
    expect(decideReconcileAction({ ...base, strongEvidence: false })).toBe('flag');
    expect(decideReconcileAction({ ...base, strongEvidence: false, hasPriorFlag: true, hasMaybeResolved: true })).toBe('none');
  });
});
