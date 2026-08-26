#!/usr/bin/env node
/**
 * monitor-telegram-member-count.mjs — daily check for a silently-stalled
 * Telegram channel. Before this script, `getChatMemberCount` had no caller
 * anywhere in the repo (issue #6507) — a member count that stops moving
 * (bot removed as admin, channel abandoned, join link broken) went
 * completely unobserved.
 *
 * Persists one {date, count} entry per day to
 * data/telegram-member-count-history.jsonl (append-only, mirrors
 * data/revenue-monitor-history.jsonl — issue #2741) and opens a stable-title
 * GitHub issue via scripts/lib/github-issue-creator.mjs when the count has
 * been unchanged for >= STAGNANT_THRESHOLD_DAYS. Re-evaluated every run; the
 * issue-creator's own dedup keeps it to one open issue until the count moves.
 *
 * Fail-soft by design (mirrors post-to-telegram.mjs / revenue-monitor.mjs):
 * missing credentials or a failed API call skip cleanly (exit 0) — this is a
 * monitor, not a gate.
 *
 * Usage:
 *   node scripts/monitor-telegram-member-count.mjs [--dry-run]
 *   --dry-run: fetch + evaluate + print, but never write history or open an issue.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { resolveTelegramCredentials, getChatMemberCount } from './lib/telegram-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
export const HISTORY_FILE = resolve(ROOT, 'data', 'telegram-member-count-history.jsonl');
export const STAGNANT_THRESHOLD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const STABLE_ISSUE_TITLE = 'Telegram channel member count stagnant (invariato da ≥30gg)';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no I/O, no env).
// ---------------------------------------------------------------------------

/** Parse the committed jsonl into an array of {date, count}. Order not assumed. */
export function parseHistory(raw) {
  if (!raw) return [];
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e && typeof e.date === 'string' && Number.isFinite(e.count));
}

function daysBetween(aDate, bDate) {
  return Math.floor((Date.parse(`${bDate}T00:00:00Z`) - Date.parse(`${aDate}T00:00:00Z`)) / DAY_MS);
}

/**
 * Decide whether `currentCount` has been unchanged for
 * >= STAGNANT_THRESHOLD_DAYS against the persisted history. Pure — exported
 * for unit tests.
 *
 * @param {{date:string, count:number}[]} history
 * @param {number} currentCount
 * @param {Date} [now]
 */
export function evaluateStagnation(history, currentCount, now = new Date()) {
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const nowStr = now.toISOString().slice(0, 10);
  if (sorted.length === 0) {
    return { stagnant: false, daysUnchanged: 0, reason: 'nessuno storico ancora persistito' };
  }
  // Walk backwards from the newest entry while the count keeps matching the
  // current value: `sinceDate` is the OLDEST entry in that unbroken run —
  // i.e. the first recorded day the count already held its current value,
  // not the last day it held the PREVIOUS one (those are different days,
  // and using the latter overcounts the unchanged streak by the gap between
  // consecutive runs — see PR discussion on issue #6507).
  let sinceDate = sorted[sorted.length - 1].date;
  let changeDate = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].count === currentCount) {
      sinceDate = sorted[i].date;
    } else {
      changeDate = sorted[i].date;
      break;
    }
  }
  const daysUnchanged = daysBetween(sinceDate, nowStr);
  return {
    stagnant: daysUnchanged >= STAGNANT_THRESHOLD_DAYS,
    daysUnchanged,
    reason: changeDate
      ? `invariato dal ${sinceDate} (ultimo valore diverso registrato il ${changeDate})`
      : `invariato sin dalla prima entry registrata (${sinceDate})`,
  };
}

// ---------------------------------------------------------------------------
// I/O defaults (overridable for tests).
// ---------------------------------------------------------------------------

function defaultLoadHistory(path) {
  if (!existsSync(path)) return [];
  return parseHistory(readFileSync(path, 'utf8'));
}

// Re-running the same day REPLACES today's entry instead of appending a
// second line for it — a rerun (retry, manual dispatch) must not double-count
// as two distinct days of "no change" evidence.
function defaultSaveHistory(path, history, entry) {
  const withoutToday = history.filter((e) => e.date !== entry.date);
  withoutToday.push(entry);
  withoutToday.sort((a, b) => a.date.localeCompare(b.date));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, withoutToday.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

async function defaultCreateIssue({ title, description }) {
  const { createGithubIssue } = await import('./lib/github-issue-creator.mjs');
  return createGithubIssue({
    title,
    description,
    priority: 4,
    labels: ['telegram'],
    workflow: 'Telegram Member Count Monitor',
  });
}

function buildIssueBody({ chatId, count, daysUnchanged, reason }) {
  return [
    '## Telegram channel member count invariato',
    '',
    `**Chat:** \`${chatId}\``,
    `**Count attuale:** ${count}`,
    `**Giorni invariato:** ${daysUnchanged} (soglia ${STAGNANT_THRESHOLD_DAYS})`,
    `**Dettaglio:** ${reason}`,
    '',
    '_Fonte: scripts/monitor-telegram-member-count.mjs, cron .github/workflows/monitor-telegram-member-count.yml. Rivalutato ogni run — resta aperta finché il count non si muove._',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Orchestration — injectable for tests (credentials/clock/state I/O/issue creator).
// ---------------------------------------------------------------------------

export async function runMemberCountMonitor({
  now = new Date(),
  historyPath = HISTORY_FILE,
  loadHistoryImpl = defaultLoadHistory,
  saveHistoryImpl = defaultSaveHistory,
  getChatMemberCountImpl = getChatMemberCount,
  createIssueImpl = defaultCreateIssue,
  credentials = resolveTelegramCredentials(),
  dryRun = false,
} = {}) {
  const { token, chatId } = credentials;
  if (!token || !chatId) {
    return { skipped: true, reason: 'missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID' };
  }

  const result = await getChatMemberCountImpl({ token, chatId });
  if (!result.ok) {
    return { skipped: true, reason: `getChatMemberCount failed: ${result.error}` };
  }

  const history = loadHistoryImpl(historyPath);
  const stagnation = evaluateStagnation(history, result.count, now);

  if (stagnation.stagnant && !dryRun) {
    await createIssueImpl({
      title: STABLE_ISSUE_TITLE,
      description: buildIssueBody({
        chatId,
        count: result.count,
        daysUnchanged: stagnation.daysUnchanged,
        reason: stagnation.reason,
      }),
    });
  }

  if (!dryRun) {
    const dateStr = now.toISOString().slice(0, 10);
    saveHistoryImpl(historyPath, history, { date: dateStr, count: result.count });
  }

  return { skipped: false, count: result.count, stagnation };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const outcome = await runMemberCountMonitor({ dryRun });
  if (outcome.skipped) {
    console.log(`[monitor-telegram-member-count] skipped: ${outcome.reason}`);
    return;
  }
  const { count, stagnation } = outcome;
  console.log(
    `[monitor-telegram-member-count] count=${count} daysUnchanged=${stagnation.daysUnchanged} ` +
      `stagnant=${stagnation.stagnant} (${stagnation.reason})`
  );
  if (stagnation.stagnant) {
    console.log('[monitor-telegram-member-count] ⚠️ stagnant >= 30gg — issue opened/deduped');
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    console.error('[monitor-telegram-member-count] failed:', e.message);
    process.exitCode = 0; // monitor, never blocks CI
  });
}
