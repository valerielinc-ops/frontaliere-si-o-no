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
 *   - which platforms are paused after a login wall or a challenge.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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

export function pressedToday(journal, channel, now, timeZone = ROBOT_TIME_ZONE) {
  const today = localDay(now, timeZone);
  return journal.attempts.filter((a) => a.channel === channel && PRESSED.has(a.outcome) && localDay(a.at, timeZone) === today).length;
}

/** Queue ids this machine must never press again on `channel`. */
export function blockedQueueIds(journal, channel) {
  return new Set(journal.attempts.filter((a) => a.channel === channel && PRESSED.has(a.outcome)).map((a) => a.queueId));
}

export function pausedUntil(journal, channel, now) {
  const until = Date.parse(journal.pausedUntil?.[channel] ?? '');
  return Number.isFinite(until) && until > new Date(now).getTime() ? new Date(until).toISOString() : null;
}

export function pauseChannel(journal, channel, now, hours = PAUSE_AFTER_BLOCK_HOURS) {
  journal.pausedUntil = { ...journal.pausedUntil, [channel]: new Date(new Date(now).getTime() + hours * 3600_000).toISOString() };
}

/** Published posts whose confirm dispatch has not been accepted yet. */
export function pendingConfirmations(journal) {
  return journal.attempts.filter((a) => a.outcome === 'published' && a.confirmDispatched !== true);
}
