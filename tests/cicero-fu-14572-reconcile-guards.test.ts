import { describe, expect, it } from 'vitest';
import {
  KEEP_OPEN_LABELS,
  decideBucketAlarmAction,
  isKeepOpenLabel,
} from '../scripts/ci/reconcile-followups.mjs';

describe('FU-2026-10-21-reconcile-followups — conservative bucket guards', () => {
  it('keeps strategic and revenue trackers outside automatic closure', () => {
    for (const label of [
      'keep-open',
      'revenue',
      'tracker',
      'do-not-close',
      'agent:no-age-out',
      'operations-audit-review',
    ]) {
      expect(KEEP_OPEN_LABELS.has(label), label).toBe(true);
    }
    expect(KEEP_OPEN_LABELS.has('maybe-resolved')).toBe(false);
  });

  it('normalizes transport label shapes before applying the close veto', () => {
    expect(isKeepOpenLabel('Keep-Open')).toBe(true);
    expect(isKeepOpenLabel({ name: 'AGENT:NO-AGE-OUT' })).toBe(true);
    expect(isKeepOpenLabel('maybe-resolved')).toBe(false);
  });

  it('requires a complete, non-disabled bucket before resolving its alarm', () => {
    expect(decideBucketAlarmAction({ listComplete: true })).toBe('resolve');
    expect(decideBucketAlarmAction({ listComplete: false })).toBe('none');
    expect(decideBucketAlarmAction({ listComplete: true, noAutoclose: true })).toBe('none');
    expect(decideBucketAlarmAction({ listComplete: true, conflicts: [14572] })).toBe('open');
    expect(decideBucketAlarmAction({ listComplete: true, unparseable: [14573] })).toBe('open');
  });
});
