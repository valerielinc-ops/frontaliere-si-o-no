/**
 * pr-autorebase non sposta la head sotto un 🔴/❌ fixer, e lo stuck-red non
 * scambia un 🔴 del review gate per un rosso ereditato da main.
 *
 * #10051 (2026-09-27): otto merge di main in tre ore, ognuno 1-16 minuti dopo
 * la review e durante il 🔴-fixer di quella review; il fixer arrivava al claim
 * con la head già spostata («HEAD cambiata dopo il claim») e usciva senza fix.
 * #10088: lo stuck-red `red-main` ha fatto la stessa cosa su un rosso del solo
 * review gate, con main verde.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  fixerInFlightOnHead,
  stuckRedRescueAllowedForSteps,
} from '../scripts/ci/pr-autorebase.mjs';
import {
  REVIEW_GATE_STEP_NAME,
  REVIEW_ABORT_STEP_NAME,
  CLAUDE_REVIEW_STEP_NAME,
  VITEST_RELATED_STEP_NAME,
} from '../scripts/ci/lib/vitestCheck.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const NOW = 1_790_520_000;
const SOURCE = readFileSync(new URL('../scripts/ci/pr-autorebase.mjs', import.meta.url), 'utf8');
const PROCESS_PR = SOURCE.slice(SOURCE.indexOf('async function processPR(pr) {'));

const claim = (over: Record<string, unknown> = {}) => ({
  state: 'active',
  workflow: 'redflag',
  headSha: HEAD,
  expiresAt: NOW + 3600,
  runId: '36326348827',
  ...over,
});

describe('fixerInFlightOnHead', () => {
  it('rinvia con una run del 🔴-fixer in coda o in corso sulla head attuale', () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'pending']) {
      expect(fixerInFlightOnHead({ runs: [{ id: 1, status, head_sha: HEAD }], claims: [], head: HEAD, nowSec: NOW }))
        .toEqual({ source: 'run', id: 1, status });
    }
  });

  it('ignora le run concluse e quelle su una head vecchia', () => {
    expect(fixerInFlightOnHead({
      runs: [
        { id: 1, status: 'completed', head_sha: HEAD },
        { id: 2, status: 'in_progress', head_sha: OLD },
      ],
      claims: [],
      head: HEAD,
      nowSec: NOW,
    })).toBeNull();
  });

  it('rinvia con un claim attivo sulla head il cui runner è in volo o illeggibile', () => {
    expect(fixerInFlightOnHead({
      runs: [], claims: [claim()], head: HEAD, nowSec: NOW, claimRunStatus: { 36326348827: 'in_progress' },
    })).toMatchObject({ source: 'claim', status: 'in_progress', workflow: 'redflag' });
    // Il ❌-fixer gira su `main`: il suo claim è l'unico segnale, e uno stato
    // del runner non leggibile resta «in volo» fino al TTL.
    expect(fixerInFlightOnHead({
      runs: [], claims: [claim({ workflow: 'redcheck' })], head: HEAD, nowSec: NOW,
    })).toMatchObject({ source: 'claim', status: 'unknown', workflow: 'redcheck' });
  });

  it('non rinvia per claim scaduti, di un runner concluso, non attivi o su un\'altra head', () => {
    const claims = [
      claim({ expiresAt: NOW - 1 }),
      claim({ runId: '7' }),
      claim({ state: 'released', runId: '8' }),
      claim({ headSha: OLD, runId: '9' }),
    ];
    expect(fixerInFlightOnHead({
      runs: [], claims, head: HEAD, nowSec: NOW, claimRunStatus: { 7: 'completed', 8: 'in_progress', 9: 'in_progress' },
    })).toBeNull();
  });

  it('processPR la valuta dopo la guardia dei tests e prima del merge di main', () => {
    const tests = PROCESS_PR.indexOf('testsRunInFlightOnHead({');
    const fixer = PROCESS_PR.indexOf('fixerInFlightOnHead({');
    const merge = PROCESS_PR.indexOf("git(['merge', '--no-edit', 'origin/main'], { allowFail: true });\n  if (merged === null)");
    expect(tests).toBeGreaterThan(-1);
    expect(fixer).toBeGreaterThan(tests);
    expect(merge).toBeGreaterThan(fixer);
    expect(PROCESS_PR.slice(fixer, fixer + 1200)).toContain('return;');
  });
});

describe('stuckRedRescueAllowedForSteps', () => {
  const gate = (conclusion: string) => ({ name: REVIEW_GATE_STEP_NAME, conclusion });

  it('esclude il rosso del solo review gate con un verdetto vero', () => {
    expect(stuckRedRescueAllowedForSteps([
      { name: VITEST_RELATED_STEP_NAME, conclusion: 'success' },
      { name: CLAUDE_REVIEW_STEP_NAME, conclusion: 'success' },
      gate('failure'),
    ])).toBe(false);
  });

  it('lascia il rescue a test rossi, review abortita o saltata e job senza step', () => {
    expect(stuckRedRescueAllowedForSteps([
      { name: VITEST_RELATED_STEP_NAME, conclusion: 'failure' },
    ])).toBe(true);
    expect(stuckRedRescueAllowedForSteps([
      { name: REVIEW_ABORT_STEP_NAME, conclusion: 'failure' },
      gate('failure'),
    ])).toBe(true);
    expect(stuckRedRescueAllowedForSteps([
      { name: CLAUDE_REVIEW_STEP_NAME, conclusion: 'skipped' },
      gate('failure'),
    ])).toBe(true);
    // Il backstop `stale` copre i rossi di infrastruttura senza step (#5019).
    expect(stuckRedRescueAllowedForSteps([])).toBe(true);
  });

  it('il commento one-shot segue un push riuscito, non lo precede', () => {
    const push = PROCESS_PR.indexOf('const pushed = pushBranch(branch);');
    const pushFailed = PROCESS_PR.indexOf('if (pushed === null)', push);
    const comment = PROCESS_PR.indexOf('commentStuckRedRescue(num, stuckRedReason);', pushFailed);
    expect(push).toBeGreaterThan(-1);
    expect(comment).toBeGreaterThan(pushFailed);
    expect(PROCESS_PR.slice(0, PROCESS_PR.indexOf("git(['merge', '--no-edit', 'origin/main'], { allowFail: true });\n  if (merged === null)")))
      .not.toContain('${STUCK_RED_MARKER}');
  });
});
