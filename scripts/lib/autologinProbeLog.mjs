/**
 * autologinProbeLog.mjs — durable count of `runAutologinProbe()` invocations
 * (#5757, item 2: "probe budget condiviso").
 *
 * `CLOCK_PROBE_BUDGET` in autologinRefusalMetrics.mjs used to be one flat
 * guess sized to cover the monitor's own daily probe AND every
 * newsletter-qa.mjs run (scheduled and manual) combined. A day with a few
 * manual QA iterations before a send burns through that guess on its own —
 * at which point either a real clock-skewed minter goes unnoticed under
 * legitimate QA noise, or the QA noise alone trips `clock_skew` with nothing
 * actually wrong.
 *
 * Each caller of runAutologinProbe() appends its own timestamp here, into its
 * own already-committed directory (docs/newsletter-qa/ for the QA script,
 * docs/autologin-refusal/ for the monitor itself), so
 * check-autologin-refusal-rate.mjs can size the window's clock budget from
 * what actually ran instead of a shared guess.
 */
import fs from 'node:fs';
import path from 'node:path';

const RETENTION_DAYS = 14;
const DAY_MS = 86_400_000;

function readEntries(logPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    return Array.isArray(parsed)
      ? parsed.filter((x) => typeof x === 'string' && !Number.isNaN(Date.parse(x)))
      : [];
  } catch {
    // Missing file, first run, or corrupt JSON all read as "nothing recorded
    // yet" — never a reason to crash the caller.
    return [];
  }
}

/** Append one invocation timestamp, pruning anything past the retention window. */
export function recordProbeRun(logPath, now = Date.now()) {
  const cutoff = now - RETENTION_DAYS * DAY_MS;
  const entries = readEntries(logPath).filter((iso) => Date.parse(iso) >= cutoff);
  entries.push(new Date(now).toISOString());
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

/** How many recorded invocations fall on or after `sinceIso`. */
export function countProbeRuns(logPath, sinceIso) {
  const sinceMs = Date.parse(sinceIso);
  return readEntries(logPath).filter((iso) => Date.parse(iso) >= sinceMs).length;
}
