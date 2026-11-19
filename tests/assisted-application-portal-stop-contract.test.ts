import { describe, expect, it } from 'vitest';
import { HINTS } from '../scripts/assisted-application/lib/portal/agent.mjs';
import { REASONS } from '../scripts/assisted-application/lib/portal/stop-report.mjs';
import { SAFE_REPORT_CODES } from '../scripts/assisted-application/portal-replay.mjs';
import {
  PORTAL_STOP_CODES,
  PORTAL_STOP_CLASSES,
  PORTAL_STOP_HINTS,
  PORTAL_STOP_REASONS,
  PORTAL_STOP_REDISCOVERY_HOLDS,
  PORTAL_STOP_RECOVERY_HOLDS,
  PORTAL_STOP_REPLAY_CODES,
  isPortalNeedsCandidateHold,
  normalizePortalStopReason,
  portalStopContract,
} from '../functions/src/lib/portalStopCodes.js';

describe('portal stop code contract', () => {
  const canonical = new Set(Object.keys(PORTAL_STOP_CODES));

  it('derives every consumer vocabulary from the canonical definitions', () => {
    expect(new Set(Object.keys(HINTS))).toEqual(new Set(Object.keys(PORTAL_STOP_HINTS)));
    expect(new Set(Object.keys(REASONS))).toEqual(new Set(Object.keys(PORTAL_STOP_REASONS)));
    expect(PORTAL_STOP_REPLAY_CODES).toEqual(canonical);

    for (const code of canonical) expect(SAFE_REPORT_CODES.has(code), code).toBe(true);
    for (const code of Object.keys(HINTS)) expect(canonical.has(code), `hint: ${code}`).toBe(true);
    for (const code of Object.keys(REASONS)) expect(canonical.has(code), `reason: ${code}`).toBe(true);
    for (const hold of PORTAL_STOP_RECOVERY_HOLDS) {
      expect(canonical.has(hold.replace(/^portal:/u, '')), `recovery: ${hold}`).toBe(true);
    }
    for (const hold of PORTAL_STOP_REDISCOVERY_HOLDS) {
      expect(canonical.has(hold.replace(/^portal:/u, '')), `rediscovery: ${hold}`).toBe(true);
    }
  });

  it('keeps question-label rediscovery narrow and unchanged', () => {
    expect([...PORTAL_STOP_REDISCOVERY_HOLDS]).toEqual(['portal:question_label_unreadable']);
  });

  it('normalizes namespaced candidate holds before applying retry behavior', () => {
    expect(normalizePortalStopReason('  PORTAL : PORTAL_NEEDS_CANDIDATE  ')).toBe('portal:portal_needs_candidate');
    expect(portalStopContract('  PORTAL : PORTAL_NEEDS_CANDIDATE  ')).toMatchObject({
      normalized: 'portal:portal_needs_candidate',
      code: 'portal_needs_candidate',
      known: true,
      category: PORTAL_STOP_CLASSES.PORTAL_RETRY,
      sourceRecovery: true,
      retryLane: 'portal',
      automaticRetry: true,
    });
    expect(isPortalNeedsCandidateHold('  PORTAL : PORTAL_NEEDS_CANDIDATE  ')).toBe(true);
    expect(isPortalNeedsCandidateHold('portal_needs_candidate')).toBe(false);
  });
});
