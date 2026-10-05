/**
 * cadence.mjs — how often the social robot may act, and its local journal.
 *
 * The journal is NOT a record of what was posted: that is the ledger on
 * origin/main (data/<channel>-posted.json), written only by confirm.mjs. The
 * journal lives in the robot's state folder on the Mac host and answers three
 * local questions the ledger cannot answer in time:
 *   - how many posts did this machine press today (the daily cap);
 *   - which queue entries did it press and is the confirm commit still on its
 *     way (never press them twice);
 *   - which platforms are paused after a login wall or a challenge, or held
 *     after a press that showed no confirmation.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ledgerKey } from '../../lib/social-publish-queue.mjs';

/** Posts pressed per platform per calendar day (Europe/Zurich). */
export const MAX_POSTS_PER_DAY_PER_PLATFORM = 2;
/** Posts pressed per platform per robot run: two launchd windows → two a day at most. */
export const MAX_POSTS_PER_RUN_PER_PLATFORM = 1;
/** Pause between two UI actions, like a person reading the dialog. */
export const HUMAN_DELAY_MS = Object.freeze({ min: 1_200, max: 4_500 });
/** Per-character typing delay of the caption. */
export const TYPING_DELAY_MS = Object.freeze({ min: 25, max: 90 });
/** Pause between the Instagram and the TikTok session of one run. */
export const BETWEEN_PLATFORMS_MS = Object.freeze({ min: 90_000, max: 360_000 });
/** Random delay at the start of a scheduled run, so launchd's fixed minute never shows. */
export const START_JITTER_MAX_MS = 20 * 60_000;
/** A login wall or a challenge pauses the platform this long: the robot does not insist. */
export const PAUSE_AFTER_BLOCK_HOURS = 12;
/** Error classes that need the owner, not another attempt. */
export const BLOCKING_ERROR_CLASSES = Object.freeze(['login-required', 'challenge']);
export const JOURNAL_LIMIT = 300;
export const ROBOT_TIME_ZONE = 'Europe/Zurich';

export function randomBetween(rng, { min, max }) {
  const r = typeof rng === 'function' ? rng() : Math.random();
  return Math.round(min + Math.max(0, Math.min(1, r)) * (max - min));
}

/** YYYY-MM-DD of `at` in the robot's time zone. */
export function localDay(at, timeZone = ROBOT_TIME_ZONE) {
  const d = new Date(at);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function emptyJournal() {
  return { schemaVersion: 1, attempts: [], pausedUntil: {} };
}

export function parseJournal(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || !Array.isArray(parsed.attempts)) return emptyJournal();
    return {
      schemaVersion: 1,
      attempts: parsed.attempts.filter((a) => a && typeof a === 'object'),
      pausedUntil: parsed.pausedUntil && typeof parsed.pausedUntil === 'object' ? { ...parsed.pausedUntil } : {},
    };
  } catch {
    return emptyJournal();
  }
}

/** A journal stored as JSON in `dir`, written atomically. */
export function fileJournalStore(dir) {
  const file = path.join(dir, 'journal.json');
  return {
    file,
    load() {
      return existsSync(file) ? parseJournal(readFileSync(file, 'utf8')) : emptyJournal();
    },
    save(journal) {
      mkdirSync(dir, { recursive: true });
      const trimmed = { ...journal, attempts: journal.attempts.slice(-JOURNAL_LIMIT) };
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(trimmed, null, 2)}\n`, 'utf8');
      renameSync(tmp, file);
    },
  };
}

/** Outcomes after which the button was pressed: they count and they block the id. */
const PRESSED = new Set(['published', 'unconfirmed']);

/**
 * Presses of `channel` on the local day of `now`. A press whose time cannot be
 * read counts as today's (fail closed: it uses up the cap instead of making
 * localDay throw and abort the whole robot run).
 */
export function pressedToday(journal, channel, now, timeZone = ROBOT_TIME_ZONE) {
  const today = localDay(now, timeZone);
  const sameDay = (at) => (Number.isFinite(new Date(at ?? '').getTime()) ? localDay(at, timeZone) === today : true);
  return journal.attempts.filter((a) => a.channel === channel && PRESSED.has(a.outcome) && sameDay(a.at)).length;
}

/**
 * Queue ids this machine must not press on `channel`: every id it already
 * pressed, plus — when `skipDryRun` — every id it already took to the button
 * in a dry run (an unattended dry run proves nothing new the second time and
 * only adds automation signals on the accounts).
 */
export function blockedQueueIds(journal, channel, { skipDryRun = false } = {}) {
  return new Set(journal.attempts
    .filter((a) => a.channel === channel && (PRESSED.has(a.outcome) || (skipDryRun && a.outcome === 'dry-run')))
    .map((a) => a.queueId));
}

/**
 * Ledger keys of the posts this machine pressed on `channel` that the ledger
 * on origin/main does not hold yet (confirm still on its way, dropped, or the
 * press was never confirmed). The posters dedup only against the ledger, so
 * the next day's queue entry may carry the same articles under a new id: the
 * robot must not press those either.
 *
 * @param {(queueId: string) => boolean} isConfirmed  queue id already in the ledger
 */
export function unsettledLedgerKeys(journal, channel, isConfirmed = () => false) {
  const keys = new Set();
  for (const a of journal.attempts) {
    // `resolvedAt`: a human checked the press and found the post NOT online.
    if (a.channel !== channel || !PRESSED.has(a.outcome) || a.resolvedAt || isConfirmed(a.queueId)) continue;
    for (const e of a.ledgerEntries || []) keys.add(ledgerKey(e));
  }
  return keys;
}

/**
 * Presses on `channel` that showed no confirmation and that no human has
 * settled yet. While one exists the robot stops on that platform: if the
 * confirmation detection is wrong, every new press would be a duplicate. A
 * human settles it by registering the post (the ledger then holds its queue
 * id), by adding `resolvedAt` to the journal line, or by deleting the line.
 */
export function openUnconfirmed(journal, channel, isConfirmed = () => false) {
  return journal.attempts.filter((a) => a.channel === channel && a.outcome === 'unconfirmed' && !a.resolvedAt && !isConfirmed(a.queueId));
}

export function pausedUntil(journal, channel, now) {
  const until = Date.parse(journal.pausedUntil?.[channel] ?? '');
  return Number.isFinite(until) && until > new Date(now).getTime() ? new Date(until).toISOString() : null;
}

export function pauseChannel(journal, channel, now, hours = PAUSE_AFTER_BLOCK_HOURS) {
  journal.pausedUntil = { ...journal.pausedUntil, [channel]: new Date(new Date(now).getTime() + hours * 3600_000).toISOString() };
}

/**
 * A dispatched confirm that has not reached the ledger after this long is sent
 * again: GitHub keeps one pending run per concurrency group, so a confirm
 * queued behind the poster can be dropped, and a confirm run can fail.
 */
export const CONFIRM_REDISPATCH_AFTER_HOURS = 2;
/** Older published presses are left to the human the confirm workflow's issue alerted. */
export const CONFIRM_REDISPATCH_MAX_DAYS = 7;

/**
 * Published posts whose confirmation has not reached the ledger: never
 * dispatched successfully, or dispatched more than
 * CONFIRM_REDISPATCH_AFTER_HOURS ago and still missing from the ledger.
 *
 * @param {{ now?: number, isConfirmed?: (channel: string, queueId: string) => boolean }} [opts]
 */
export function pendingConfirmations(journal, { now = Date.now(), isConfirmed = () => false } = {}) {
  const nowMs = new Date(now).getTime();
  return journal.attempts.filter((a) => {
    if (a.outcome !== 'published' || isConfirmed(a.channel, a.queueId)) return false;
    if (a.confirmDispatched !== true) return true;
    const pressedAt = Date.parse(a.at ?? '');
    if (!Number.isFinite(pressedAt) || nowMs - pressedAt > CONFIRM_REDISPATCH_MAX_DAYS * 24 * 3600_000) return false;
    const sentAt = Date.parse(a.confirmDispatchedAt ?? a.at ?? '');
    return Number.isFinite(sentAt) && nowMs - sentAt >= CONFIRM_REDISPATCH_AFTER_HOURS * 3600_000;
  });
}
