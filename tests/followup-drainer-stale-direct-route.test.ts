import { describe, expect, it } from 'vitest';
import {
  isStaleDirectFixRouteCandidate,
  staleDirectFixRouteDecision,
} from '../scripts/ci/followup-drainer.mjs';

const pinnedDirectFix = {
  number: 6369,
  title: 'Keep this tracker',
  body: 'The issue is intentionally pinned outside the autonomous route.',
  labels: [{ name: 'agent:fix' }, { name: 'keep-open' }],
};

describe('follow-up drainer stale direct routes', () => {
  it('recognizes agent:fix left behind after the route becomes none', () => {
    expect(isStaleDirectFixRouteCandidate(pinnedDirectFix)).toBe(true);
  });

  it('dequeues only after live claim, PR, run, and settling gates pass', () => {
    expect(staleDirectFixRouteDecision(pinnedDirectFix, {
      inFlight: 0,
      liveClaimAllowed: true,
      hasOpenPr: false,
      settling: false,
    })).toEqual({
      action: 'dequeue',
      reason: 'la classificazione corrente restituisce route none',
    });
  });

  it('keeps the route when the open-PR read is not verifiable', () => {
    expect(staleDirectFixRouteDecision(pinnedDirectFix, {
      inFlight: 0,
      liveClaimAllowed: true,
      hasOpenPr: null,
      settling: false,
    }).action).toBe('keep');
  });
});
