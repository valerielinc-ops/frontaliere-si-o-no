import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { recordProbeRun, countProbeRuns } from '../scripts/lib/autologinProbeLog.mjs';

/**
 * #5757 (item 2) — the durable counters that let check-autologin-refusal-rate.mjs
 * size its clock budget from what actually ran, instead of one flat guess
 * shared between the monitor's own daily probe and every newsletter-qa.mjs run.
 */

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
});

function tmpLogPath(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'autologin-probe-log-'));
  tmpDirs.push(d);
  return path.join(d, 'probe-log.json');
}

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('#5757 — autologin probe log', () => {
  it('counts nothing against a file that has never been written', () => {
    const logPath = tmpLogPath();
    expect(countProbeRuns(logPath, iso(0))).toBe(0);
  });

  it('records an invocation and counts it back from the same or an earlier "since"', () => {
    const logPath = tmpLogPath();
    const now = Date.parse('2026-08-13T12:00:00.000Z');
    recordProbeRun(logPath, now);
    expect(countProbeRuns(logPath, iso(now))).toBe(1);
    expect(countProbeRuns(logPath, iso(now - DAY_MS))).toBe(1);
    expect(countProbeRuns(logPath, iso(now + 1))).toBe(0);
  });

  it('accumulates across multiple recorded runs — the manual-dispatch case', () => {
    const logPath = tmpLogPath();
    const now = Date.parse('2026-08-13T12:00:00.000Z');
    recordProbeRun(logPath, now);
    recordProbeRun(logPath, now + 1000);
    recordProbeRun(logPath, now + 2000);
    expect(countProbeRuns(logPath, iso(now - 1))).toBe(3);
  });

  it('prunes entries past the retention window instead of growing the file forever', () => {
    const logPath = tmpLogPath();
    const now = Date.parse('2026-08-13T12:00:00.000Z');
    recordProbeRun(logPath, now - 20 * DAY_MS); // well past retention
    recordProbeRun(logPath, now);
    const raw = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    expect(raw).toHaveLength(1);
    expect(countProbeRuns(logPath, iso(now - 30 * DAY_MS))).toBe(1);
  });

  it('a window boundary excludes what falls strictly before it — the actual query check-autologin-refusal-rate.mjs runs', () => {
    // This is the property the fix depends on: newsletter-qa.mjs may have run
    // yesterday, outside today's 24h monitor window, and must not inflate
    // today's budget.
    const logPath = tmpLogPath();
    const now = Date.parse('2026-08-13T12:00:00.000Z');
    recordProbeRun(logPath, now - 2 * DAY_MS); // outside a 24h window
    recordProbeRun(logPath, now - 1000); // inside it
    const sinceIso = iso(now - DAY_MS);
    expect(countProbeRuns(logPath, sinceIso)).toBe(1);
  });

  it('degrades to zero — never throws — on corrupt or non-JSON content', () => {
    const logPath = tmpLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'not json', 'utf8');
    expect(countProbeRuns(logPath, iso(0))).toBe(0);
    // And a subsequent record still works — corruption self-heals on next write.
    recordProbeRun(logPath, Date.parse('2026-08-13T00:00:00.000Z'));
    expect(countProbeRuns(logPath, iso(0))).toBe(1);
  });
});
