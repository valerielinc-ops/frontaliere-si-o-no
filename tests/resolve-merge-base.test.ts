/**
 * resolve-merge-base.mjs coverage (issue #5195).
 *
 * formatUnresolvableMergeBaseMessage is pure and fully unit-tested here.
 * resolveMergeBase spawns real git, so it is exercised against THIS repo's
 * actual (non-shallow, in CI) checkout — `base: 'HEAD'` always has a
 * merge-base with itself (HEAD), giving a deterministic non-shallow-path
 * assertion without depending on network/origin state.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveMergeBase,
  formatUnresolvableMergeBaseMessage,
} from '../scripts/ci/lib/resolve-merge-base.mjs';

describe('formatUnresolvableMergeBaseMessage', () => {
  it('mentions the shallow clone without deepening when deepened=false', () => {
    const msg = formatUnresolvableMergeBaseMessage('origin/main', false);
    expect(msg).toContain('su clone shallow');
    expect(msg).not.toContain('anche dopo aver approfondito');
  });

  it('mentions the deepen attempt when deepened=true', () => {
    const msg = formatUnresolvableMergeBaseMessage('origin/main', true);
    expect(msg).toContain('anche dopo aver approfondito il clone shallow');
  });

  it('includes the base ref for debuggability', () => {
    const msg = formatUnresolvableMergeBaseMessage('origin/main', false);
    expect(msg).toContain('origin/main');
  });
});

describe('resolveMergeBase (real git, non-shallow path)', () => {
  it('resolves HEAD vs HEAD without needing to deepen', () => {
    const { mergeBase, deepened } = resolveMergeBase('HEAD');
    expect(mergeBase).toBeTruthy();
    expect(deepened).toBe(false);
  });
});
