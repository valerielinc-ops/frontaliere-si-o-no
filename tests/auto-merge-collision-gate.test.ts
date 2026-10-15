/**
 * Precise collision gate — `collisionGateDecision` + `parseCollisionPeers`
 * (issue #2424).
 *
 * The collision gate used to block a `collision-risk` PR whenever it was behind
 * main by any amount (`behind_by > 0`). Under fast-moving main that starves the
 * PR: an UNRELATED merge pushes it behind again between rebase and re-eval →
 * re-rebase → re-vitest, forever (livelock). The real #1454 hazard is narrower:
 * a colliding PEER that already merged must be incorporated into head. This gate
 * blocks ONLY on that, while tolerating unrelated main commits.
 */

import { describe, expect, it } from 'vitest';
import {
  collisionGateDecision,
  parseCollisionPeers,
} from '../scripts/ci/auto-merge-eval.mjs';

describe('parseCollisionPeers', () => {
  it('extracts peer PR numbers from COLLISION markers', () => {
    const comments = [
      '<!-- COLLISION:2415 -->\nshared build-plugins/foo.ts',
      'some unrelated comment',
      '<!-- COLLISION:2420 -->\nshared scripts/lib/bar.mjs',
    ].join('\n');
    expect(parseCollisionPeers(comments)).toEqual([2415, 2420]);
  });

  it('dedups repeated markers and preserves first-seen order', () => {
    const comments = '<!-- COLLISION:99 -->\nx\n<!-- COLLISION:7 -->\n<!-- COLLISION:99 -->';
    expect(parseCollisionPeers(comments)).toEqual([99, 7]);
  });

  it('returns [] when no markers / empty input', () => {
    expect(parseCollisionPeers('no markers here')).toEqual([]);
    expect(parseCollisionPeers('')).toEqual([]);
    expect(parseCollisionPeers()).toEqual([]);
  });
});

describe('collisionGateDecision — precise #1454 hazard gate', () => {
  it('0 behind → always allowed (unchanged base case)', () => {
    const d = collisionGateDecision({ behind: 0, mergedPeers: [] });
    expect(d.allow).toBe(true);
  });

  it('behind unrelated commits, NO merged peers → allowed (kills the starvation case)', () => {
    // The whole point of #2424: behind>0 purely from unrelated main traffic must
    // not block when no colliding peer has actually merged.
    const d = collisionGateDecision({ behind: 12, mergedPeers: [] });
    expect(d.allow).toBe(true);
    expect(d.reason).toMatch(/nessun peer collidente mergiato/);
  });

  it('behind, merged peer NOT yet in head → blocked (preserves invariant #1454)', () => {
    const d = collisionGateDecision({
      behind: 3,
      mergedPeers: [{ number: 2415, includedInHead: false }],
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/#2415/);
  });

  it('behind, merged peer ALREADY in head → allowed (rebased past the peer)', () => {
    const d = collisionGateDecision({
      behind: 5,
      mergedPeers: [{ number: 2415, includedInHead: true }],
    });
    expect(d.allow).toBe(true);
    expect(d.reason).toMatch(/tutti i 1 peer/);
  });

  it('mixed peers: one incorporated, one not → blocked, names only the missing one', () => {
    const d = collisionGateDecision({
      behind: 8,
      mergedPeers: [
        { number: 2415, includedInHead: true },
        { number: 2420, includedInHead: false },
      ],
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('#2420');
    expect(d.reason).not.toContain('#2415');
  });

  it('all merged peers incorporated despite large behind → allowed', () => {
    const d = collisionGateDecision({
      behind: 40,
      mergedPeers: [
        { number: 1, includedInHead: true },
        { number: 2, includedInHead: true },
      ],
    });
    expect(d.allow).toBe(true);
  });

  it('safe defaults (no args) → allowed (0 behind)', () => {
    expect(collisionGateDecision().allow).toBe(true);
    expect(collisionGateDecision({}).allow).toBe(true);
  });
});
