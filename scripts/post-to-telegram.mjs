#!/usr/bin/env node
/**
 * Telegram broadcast poster for the free Bot API channel.
 *
 * Three modes:
 *   jobs             — the "jobs of the day" digest: the top-N freshest
 *                       never-posted jobs, deduped across runs via
 *                       data/telegram-posted-jobs.json. Reuses the same
 *                       recency selection as the Reddit/FB schedulers.
 *   border           — the WEEKLY best/worst dogane wait-time ranking, reusing
 *                       the same aggregation lib as the on-site ranking
 *                       article. This mode imports `.ts` modules, so it MUST
 *                       run under `tsx`:
 *                         npx tsx scripts/post-to-telegram.mjs border
 *                       The jobs mode stays plain `node` (never imports the
 *                       .ts path).
 *   preferred-source — ONE-OFF announcement (not a cron) explaining how to
 *                       add the site as a Google "preferred source". Deduped
 *                       via data/telegram-posted-announcements.json so a
 *                       re-dispatch never double-posts the same message.
 *
 * SAFETY / FAIL-SOFT:
 *   • Preview (dry-run) is the DEFAULT. A real post happens only with `--send`
 *     (or TELEGRAM_SEND=1) AND both TELEGRAM_BOT_TOKEN + TELEGRAM_CHANNEL_ID set.
 *   • With no credentials the script logs a clear skip and exits 0 — the whole
 *     infrastructure is in place; activation is a one-time owner config (create
 *     the bot + channel, store the token). CI stays green with no token.
 *   • Every error path logs and exits 0 — a broadcast hiccup never blocks CI.
 *
 * Usage:
 *   node    scripts/post-to-telegram.mjs jobs             [--send] [--limit N] [--dry-run]
 *   npx tsx scripts/post-to-telegram.mjs border            [--send]            [--dry-run]
 *   node    scripts/post-to-telegram.mjs preferred-source  [--send]            [--dry-run]
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID — Bot API credentials.
 *   TELEGRAM_SEND=1        — post for real (same as --send). Default: preview.
 *   TELEGRAM_JOBS_LIMIT=N  — jobs per digest (default 5).
 *   TODAY_ISO=YYYY-MM-DD   — pin "today" for the border window (tests/CI).
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  selectUnpostedJobs,
  loadLedger,
  appendLedger,
} from './lib/social-post-utils.mjs';
import {
  hasTelegramCredentials,
  resolveTelegramCredentials,
  sendMessage,
} from './lib/telegram-client.mjs';
import {
  buildDailyJobsDigest,
  buildPreferredSourceAnnouncement,
  DEFAULT_JOBS_LIMIT,
  PREFERRED_SOURCE_ANNOUNCEMENT_ID,
} from './lib/telegram-templates.mjs';

// Ledger trim cap (mirrors the Reddit poster).
const POSTED_TRIM_LIMIT = 1000;

function defaultRepoRoot() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return resolve(__dirname, '..');
}

function jobsPath(repoRoot) {
  // Prefer public/data, fall back to data/ (agent worktrees only have the
  // latter). Same precedence as the Reddit/FB schedulers.
  const pub = resolve(repoRoot, 'public', 'data', 'jobs.json');
  if (existsSync(pub)) return pub;
  return resolve(repoRoot, 'data', 'jobs.json');
}

function postedJobsPath(repoRoot) {
  return resolve(repoRoot, 'data', 'telegram-posted-jobs.json');
}

function postedAnnouncementsPath(repoRoot) {
  return resolve(repoRoot, 'data', 'telegram-posted-announcements.json');
}

function loadJobs(repoRoot, log) {
  const file = jobsPath(repoRoot);
  try {
    if (!existsSync(file)) {
      log('⚠️', `jobs.json not found at ${file}`);
      return [];
    }
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    log('⚠️', `failed to read jobs.json: ${err.message}`);
    return [];
  }
}

function itDateLabel(now) {
  try {
    return now.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Build the message + (jobs mode) the ledger commit callback. */
async function buildForMode(mode, { env, repoRoot, now, log }) {
  if (mode === 'border') {
    // tsx-only path — dynamically imported so the jobs mode can stay on plain
    // `node` (this module transitively imports `.ts` files).
    const { buildWeeklyBorderDigest } = await import('./lib/telegram-border-digest.mjs');
    const historyDir = resolve(repoRoot, 'data', 'border-wait-history');
    const todayIso = env.TODAY_ISO || now.toISOString().slice(0, 10);
    const { text, rankedCount } = buildWeeklyBorderDigest({ historyDir, todayIso });
    log('ℹ️', `border ranking: ${rankedCount} crossings ranked`);
    return { text, onSent: null };
  }

  if (mode === 'preferred-source') {
    const ledgerPath = postedAnnouncementsPath(repoRoot);
    const ledger = loadLedger(ledgerPath);
    const alreadySent = ledger.posted.some((e) => e?.id === PREFERRED_SOURCE_ANNOUNCEMENT_ID);
    if (alreadySent) {
      log('ℹ️', 'preferred-source announcement already posted — skipping (one-off, not a recurring digest)');
      return { text: '', onSent: null };
    }
    const { text } = buildPreferredSourceAnnouncement();
    const onSent = () =>
      appendLedger(ledgerPath, [{ id: PREFERRED_SOURCE_ANNOUNCEMENT_ID, ts: new Date().toISOString() }]);
    return { text, onSent };
  }

  // jobs mode (default)
  const limitRaw = Number(env.TELEGRAM_JOBS_LIMIT);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_JOBS_LIMIT;

  const jobs = loadJobs(repoRoot, log);
  if (jobs.length === 0) {
    log('ℹ️', 'no jobs available');
    return { text: '', onSent: null };
  }

  const ledgerPath = postedJobsPath(repoRoot);
  const ledger = loadLedger(ledgerPath);
  const postedSet = new Set(ledger.posted.map((e) => e?.id).filter(Boolean));

  // Take a buffer (2×) so digest can drop any job without a resolvable URL and
  // still fill the shortlist.
  const candidates = selectUnpostedJobs(jobs, postedSet, limit * 2);
  const dateLabel = itDateLabel(now);
  const { text, jobIds } = buildDailyJobsDigest(candidates, { limit, dateLabel });

  // On a successful real send, record the posted job ids so tomorrow's digest
  // doesn't repeat them.
  const onSent = jobIds.length
    ? () =>
        appendLedger(
          ledgerPath,
          jobIds.map((id) => ({ id, ts: new Date().toISOString() })),
          POSTED_TRIM_LIMIT,
        )
    : null;

  return { text, onSent };
}

async function main() {
  const args = process.argv.slice(2);
  const env = process.env;
  const positional = args.filter((a) => !a.startsWith('--'));
  const mode = ['border', 'preferred-source'].includes(positional[0]) ? positional[0] : 'jobs';

  const forceDry = args.includes('--dry-run');
  const wantSend = args.includes('--send') || env.TELEGRAM_SEND === '1' || env.TELEGRAM_SEND === 'true';
  const dryRun = forceDry || !wantSend;

  // --limit N overrides TELEGRAM_JOBS_LIMIT for the jobs mode.
  const limitIdx = args.indexOf('--limit');
  if (limitIdx !== -1 && args[limitIdx + 1]) env.TELEGRAM_JOBS_LIMIT = args[limitIdx + 1];

  const log = (icon, msg) => console.log(`${icon} ${msg}`);
  const repoRoot = defaultRepoRoot();
  const now = new Date();

  log('📣', `Telegram broadcast — mode=${mode}, send=${!dryRun}`);

  const { text, onSent } = await buildForMode(mode, { env, repoRoot, now, log });

  if (!text) {
    log('ℹ️', 'nothing to post this run — exiting');
    return;
  }

  console.log('─── Telegram message preview ───');
  console.log(text);
  console.log('────────────────────────────────');

  if (dryRun) {
    log('🏃', 'preview only (dry-run) — not posting. Pass --send (or TELEGRAM_SEND=1) to post for real.');
    return;
  }

  if (!hasTelegramCredentials(env)) {
    log('⚠️', 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID not set — skipping send (channel not yet configured).');
    return;
  }

  const { token, chatId } = resolveTelegramCredentials(env);
  const res = await sendMessage({ token, chatId, text });
  if (res.ok) {
    log('✅', `posted to Telegram (message_id=${res.messageId ?? '?'})`);
    if (onSent) onSent();
  } else {
    log('⚠️', `Telegram send failed: ${res.error}`);
  }
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error('⚠️ post-to-telegram crashed:', err?.message || err);
      process.exit(0); // soft-fail — never block CI
    },
  );
}

export { buildForMode };
