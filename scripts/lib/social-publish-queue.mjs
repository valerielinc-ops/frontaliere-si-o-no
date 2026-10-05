/**
 * social-publish-queue.mjs — the ONE queue of ready Instagram/TikTok posts.
 *
 * The daily posters (scripts/post-to-instagram.mjs, scripts/post-to-tiktok.mjs)
 * pick the carousel, render its slides, upload them to the CDN and then either
 * call the platform API or — when the Playwright robot is the transport — put
 * the finished post here. The robot (scripts/social-robot/) reads this queue
 * from origin/main, publishes from the owner's browser profile on the agents'
 * Mac host, and only after it has SEEN the platform's confirmation does
 * scripts/social-robot/confirm.mjs (run by social-robot-confirm.yml) move the
 * entry into the same ledger the API path writes (data/<channel>-posted.json).
 * So there is one picker, one queue and one ledger; the robot never decides
 * what to post and never writes the ledger itself.
 *
 * Dependency-free on purpose (node builtins only): the robot runs from a
 * snapshot of scripts/ on the Mac host, without build-plugins/ or data/.
 *
 * The switch between the API pipeline and the robot is the Remote Config
 * parameter SOCIAL_ROBOT_MODE (mapped in scripts/load-rc-env.mjs):
 *   off   the API pipeline only, as before the robot existed
 *   dry   default (absent, empty or unknown value): the posters still use the
 *         API when it has credentials, and otherwise queue the post; the robot
 *         goes up to the publish button and never presses it, even when it is
 *         launched with --publish
 *   live  the posters never call the API and always queue; the robot launched
 *         with --publish presses the button
 * Every value is shorter than six characters on purpose: the loader masks any
 * longer RC value in CI logs (isTrivialSecret), and a masked "publish" would
 * turn every log line containing that word into `***`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SOCIAL_CHANNELS = Object.freeze(['instagram', 'tiktok']);
export const SOCIAL_ROBOT_MODES = Object.freeze(['off', 'dry', 'live']);
export const DEFAULT_SOCIAL_ROBOT_MODE = 'dry';
export const SOCIAL_ROBOT_MODE_ENV = 'SOCIAL_ROBOT_MODE';
export const QUEUE_SCHEMA_VERSION = 1;

/** The images the robot downloads come only from the site's own CDN. */
export const SOCIAL_IMAGE_ORIGIN = 'https://cdn.frontaliereticino.ch';

/**
 * How long a queued post stays worth publishing. A daily "most read of
 * yesterday" carousel is stale after a day and a half; the weekly border
 * ranking after a week. The posters replace an entry of the same kind every
 * run, so in normal operation an entry is younger than a day anyway: the TTL
 * only matters when the poster stops and the robot keeps running.
 */
export const QUEUE_TTL_HOURS = Object.freeze({ article: 36, job: 36, border: 7 * 24 });

/** Marker the confirm step writes on every ledger entry it adds. */
export const ROBOT_LEDGER_VIA = 'playwright-robot';

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {'off'|'dry'|'live'}
 */
export function resolveSocialRobotMode(env = process.env) {
  const raw = String(env?.[SOCIAL_ROBOT_MODE_ENV] ?? '').trim().toLowerCase();
  return SOCIAL_ROBOT_MODES.includes(raw) ? /** @type {any} */ (raw) : DEFAULT_SOCIAL_ROBOT_MODE;
}

/**
 * What a poster does with a finished carousel.
 *   api      call the platform API (only with credentials, never in live mode)
 *   enqueue  put the post in the robot's queue when the API did not publish it
 *   render   whether rendering + uploading the slides is worth doing at all
 *
 * @param {{ mode: string, apiReady: boolean }} opts
 */
export function socialPublishRoute({ mode, apiReady }) {
  const ready = Boolean(apiReady);
  if (mode === 'off') return { api: ready, enqueue: false, render: ready };
  if (mode === 'live') return { api: false, enqueue: true, render: true };
  return { api: ready, enqueue: true, render: true };
}

/**
 * The last step of a poster, shared by both channels and every carousel kind:
 * API first when the route allows it, the queue when the API did not publish.
 *
 * `dequeue` is mandatory and runs after every successful API publish: it must
 * drop the pending queue entry of the same channel and kind (dequeuePosts), or
 * a post queued by an earlier token-less run stays there for the robot to
 * press after the API already covered the slot.
 *
 * @param {{ route: { api: boolean, enqueue: boolean }, label: string,
 *   publish: () => Promise<{ ok: boolean, reason?: string }>,
 *   recordPublished: (res: object) => void, enqueue: () => void,
 *   dequeue: () => void, log?: Pick<Console, 'log'|'error'> }} opts
 * @returns {Promise<'api'|'queued'|'api-failed'|'skipped'>}
 */
export async function deliverSocialPost({ route, label, publish, recordPublished, enqueue, dequeue, log = console }) {
  if (typeof dequeue !== 'function') {
    throw new TypeError(`${label}: deliverSocialPost needs a dequeue step for the API path`);
  }
  if (route.api) {
    const res = await publish();
    if (res?.ok) {
      recordPublished(res);
      dequeue();
      return 'api';
    }
    log.error(`⚠️  ${label} publish failed: ${res?.reason || 'unknown reason'}`);
  }
  if (route.enqueue) {
    enqueue();
    log.log(`🗂️  ${label}: queued for the Playwright robot (scripts/social-robot/)`);
    return 'queued';
  }
  return route.api ? 'api-failed' : 'skipped';
}

export function queuePathFor(root, channel) {
  assertChannel(channel);
  return path.join(root, 'data', `${channel}-queue.json`);
}

export function ledgerPathFor(root, channel) {
  assertChannel(channel);
  return path.join(root, 'data', `${channel}-posted.json`);
}

function assertChannel(channel) {
  if (!SOCIAL_CHANNELS.includes(channel)) throw new Error(`unknown social channel: ${channel}`);
}

export function emptyQueue() {
  return { schemaVersion: QUEUE_SCHEMA_VERSION, pending: [] };
}

/** Parse queue JSON text; anything malformed reads as an empty queue. */
export function parseQueue(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.pending)) return emptyQueue();
    return { schemaVersion: QUEUE_SCHEMA_VERSION, pending: parsed.pending.filter((e) => e && typeof e === 'object') };
  } catch {
    return emptyQueue();
  }
}

/**
 * Parse ledger JSON text (data/<channel>-posted.json); malformed → empty.
 * The one ledger parser: loadLedger in social-post-utils.mjs reads the file
 * and delegates here.
 */
export function parseLedger(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.posted)) return { schemaVersion: 1, posted: [] };
    return { schemaVersion: Number(parsed.schemaVersion) || 1, posted: parsed.posted };
  } catch {
    return { schemaVersion: 1, posted: [] };
  }
}

export function loadQueue(filePath) {
  if (!existsSync(filePath)) return emptyQueue();
  return parseQueue(readFileSync(filePath, 'utf8'));
}

export function saveQueue(filePath, queue) {
  const out = { schemaVersion: QUEUE_SCHEMA_VERSION, pending: queue.pending };
  writeFileSync(filePath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
}

function toIso(now) {
  return new Date(now instanceof Date ? now.getTime() : now ?? Date.now()).toISOString();
}

/**
 * The queue entry for one finished carousel. `id` is `<kind>-<day>`, the same
 * key the slides were uploaded under, so a re-run of the same day replaces the
 * entry instead of adding a twin.
 *
 * @param {{ channel: string, kind: string, day: string, caption: string,
 *   imageUrls: string[], ledgerEntries: object[], now?: number|Date }} opts
 */
export function buildQueueEntry({ channel, kind, day, caption, imageUrls, ledgerEntries, now = Date.now() }) {
  assertChannel(channel);
  const ttlHours = QUEUE_TTL_HOURS[kind];
  if (!ttlHours) throw new Error(`unknown carousel kind: ${kind}`);
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) throw new Error('a queued post needs at least one image');
  for (const url of imageUrls) {
    if (!isAllowedImageUrl(url)) throw new Error(`image outside ${SOCIAL_IMAGE_ORIGIN}: ${url}`);
  }
  if (!String(caption || '').trim()) throw new Error('a queued post needs a caption');
  const createdMs = new Date(toIso(now)).getTime();
  return {
    id: `${kind}-${day}`,
    channel,
    kind,
    day,
    caption,
    imageUrls: [...imageUrls],
    ledgerEntries: (ledgerEntries || []).map((e) => ({ ...e })),
    createdAt: new Date(createdMs).toISOString(),
    expiresAt: new Date(createdMs + ttlHours * 3600_000).toISOString(),
  };
}

export function isAllowedImageUrl(url) {
  try {
    const u = new URL(String(url));
    return `${u.protocol}//${u.host}` === SOCIAL_IMAGE_ORIGIN && u.pathname.startsWith('/images/social/');
  } catch {
    return false;
  }
}

export function isExpired(entry, now = Date.now()) {
  const exp = Date.parse(entry?.expiresAt ?? '');
  return !Number.isFinite(exp) || exp <= new Date(toIso(now)).getTime();
}

/**
 * Add `entry`, replacing any pending entry of the same kind (a newer daily
 * ranking supersedes yesterday's unpublished one) and dropping expired ones.
 */
export function upsertPending(queue, entry, now = Date.now()) {
  const kept = parseQueue(queue).pending.filter((e) => e.kind !== entry.kind && !isExpired(e, now));
  return { schemaVersion: QUEUE_SCHEMA_VERSION, pending: [...kept, entry] };
}

/** Read the queue file, upsert, write it back. */
export function enqueuePost(filePath, entry, now = Date.now()) {
  const next = upsertPending(loadQueue(filePath), entry, now);
  saveQueue(filePath, next);
  return next;
}

/**
 * Drop every pending entry of `channel` and `kind` — what a successful API
 * publish of that kind supersedes, whatever day it was queued for.
 */
export function dropPending(queue, { channel, kind }) {
  return {
    schemaVersion: QUEUE_SCHEMA_VERSION,
    pending: parseQueue(queue).pending.filter((e) => !(e.channel === channel && e.kind === kind)),
  };
}

/** Read the queue file, drop the channel/kind entries, write it back if it changed. */
export function dequeuePosts(filePath, { channel, kind }) {
  assertChannel(channel);
  if (!existsSync(filePath)) return emptyQueue();
  const current = loadQueue(filePath);
  const next = dropPending(current, { channel, kind });
  if (next.pending.length !== current.pending.length) saveQueue(filePath, next);
  return next;
}

/** The dedup key of a ledger entry: `<kind>:<id>`, what the posters skip for 30 days. */
export function ledgerKey(e) {
  return `${e?.kind ?? ''}:${e?.id ?? ''}`;
}

/** Whether the ledger already holds the robot's confirmation for `queueId`. */
export function isConfirmedInLedger(ledger, queueId) {
  return parseLedger(ledger).posted.some((e) => e?.queueId === queueId);
}

/**
 * The next post the robot may attempt on `channel`, or null.
 *
 * Skips: entries of another channel, expired entries, entries the ledger
 * already confirms, entries the local journal says were published (waiting
 * for the confirm commit to land) or left unconfirmed (a human must look),
 * entries carrying any ledger key (`<kind>:<id>`) already present in the
 * ledger or belonging to such a press — the next day's entry may repeat the
 * same articles under a new id — and entries whose images are not on the
 * site's CDN. Oldest first.
 *
 * @param {{ pending: object[] }} queue
 * @param {{ channel: string, now?: number|Date, ledger?: object,
 *   blockedIds?: Set<string>, blockedLedgerKeys?: Set<string> }} opts
 */
export function selectNextPending(queue, { channel, now = Date.now(), ledger = null, blockedIds = new Set(), blockedLedgerKeys = new Set() }) {
  const ledgerKeys = new Set(parseLedger(ledger).posted.map(ledgerKey));
  const candidates = parseQueue(queue).pending
    .filter((e) => e.channel === channel)
    .filter((e) => !isExpired(e, now))
    .filter((e) => !(ledger && isConfirmedInLedger(ledger, e.id)))
    .filter((e) => !blockedIds.has(e.id))
    .filter((e) => !(e.ledgerEntries || []).some((l) => ledgerKeys.has(ledgerKey(l))))
    .filter((e) => !(e.ledgerEntries || []).some((l) => blockedLedgerKeys.has(ledgerKey(l))))
    .filter((e) => Array.isArray(e.imageUrls) && e.imageUrls.length > 0 && e.imageUrls.every(isAllowedImageUrl))
    .filter((e) => String(e.caption || '').trim());
  candidates.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return candidates[0] || null;
}

/**
 * Move a confirmed post from the queue into the ledger.
 *
 * Returns the queue without the entry and the ledger entries to append. The
 * ledger entries sent along with the confirmation, when there are any, are
 * authoritative: they are what the robot actually published, while the queue
 * entry under the same id may be a same-day re-run's replacement with other
 * items. The queue entry's own entries are used only when the confirmation
 * carries none. A second confirmation of the same id adds nothing.
 *
 * @param {{ queue: object, ledger: object, queueId: string, confirmedAt: string,
 *   evidence?: string, fallbackLedgerEntries?: object[] }} opts
 */
export function confirmQueueEntry({ queue, ledger, queueId, confirmedAt, evidence = '', fallbackLedgerEntries = [] }) {
  const q = parseQueue(queue);
  const entry = q.pending.find((e) => e.id === queueId) || null;
  const remaining = { schemaVersion: QUEUE_SCHEMA_VERSION, pending: q.pending.filter((e) => e.id !== queueId) };
  if (isConfirmedInLedger(ledger, queueId)) {
    return { queue: remaining, ledgerEntries: [], alreadyConfirmed: true, source: 'ledger' };
  }
  const sent = Array.isArray(fallbackLedgerEntries) && fallbackLedgerEntries.length > 0;
  const base = sent ? fallbackLedgerEntries : entry?.ledgerEntries;
  if (!Array.isArray(base) || base.length === 0) {
    throw new Error(`no ledger entries for ${queueId}: not in the queue and none sent with the confirmation`);
  }
  const ts = new Date(confirmedAt).toISOString();
  const ledgerEntries = base.map((e) => ({
    ...e,
    ts,
    queueId,
    via: ROBOT_LEDGER_VIA,
    ...(evidence ? { robotEvidence: String(evidence).slice(0, 200) } : {}),
  }));
  return { queue: remaining, ledgerEntries, alreadyConfirmed: false, source: sent ? 'confirmation' : 'queue' };
}
