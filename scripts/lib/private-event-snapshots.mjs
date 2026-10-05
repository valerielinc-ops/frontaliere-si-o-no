/**
 * Private event snapshots: the only place where Eventfrog data lives.
 *
 * DESIGN (owner decision D5 of 2026-10-05, Eventfrog AGB v1.28 §17)
 *
 *   crawl-events.yml ──sync-eventfrog-snapshot.mjs──▶ Firebase Storage
 *        (daily)                                       gs://<bucket>/private-event-snapshots/eventfrog-ti.json
 *                                                      (Admin SDK only; storage.rules deny every client)
 *   deploy.yml ──fetch-private-event-snapshots.mjs──▶ .cache/private-events/eventfrog-ti.json
 *        (every build)                                 (git-ignored, outside data/ and public/)
 *   eventsSeoPagesPlugin ──loadEphemeralEvents()──▶ live detail/listing pages only
 *
 * - The snapshot is a COMPLETE replacement on every sync, never a merge: an
 *   event Eventfrog no longer returns is gone from the next snapshot, so its
 *   page is not emitted by the next build (§17(5)). The shard push removes
 *   files a build no longer emits, so the URL then answers 404 and the page
 *   leaves sitemap-eventi.xml — the same path every other page the build stops
 *   emitting takes. Nothing is archived and no redirect is kept for it.
 * - A snapshot older than SNAPSHOT_MAX_AGE_HOURS is ignored entirely: a missed
 *   daily sync must stop the publication rather than serve stale data (§17(5)
 *   "einmal täglich aktualisiert").
 * - `EVENTFROG_ENABLED` (Remote Config, loaded by scripts/load-rc-env.mjs,
 *   default false) gates the sync, the download and the page emission. Absent
 *   or any value other than the exact string `true` means off.
 * - Never read from or written to a tracked path: the repositories and the
 *   corpus' data API are public (§17(3)). See scripts/lib/private-event-sources.mjs
 *   for the exclusion applied by every other reader of the events dataset.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeText, slugifyEvent, upcomingEvents } from './events-utils.mjs';
import { isPrivateEventRecord } from './private-event-sources.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Bucket of the Firebase project (same default bucket the functions use). */
export const PRIVATE_EVENTS_BUCKET =
  process.env.FIREBASE_STORAGE_BUCKET || process.env.STORAGE_BUCKET || 'frontaliere-ticino.firebasestorage.app';
/** Storage prefix denied to every client by storage.rules. */
export const PRIVATE_EVENTS_STORAGE_PREFIX = 'private-event-snapshots/';
export const EVENTFROG_SNAPSHOT_OBJECT = `${PRIVATE_EVENTS_STORAGE_PREFIX}eventfrog-ti.json`;
/** Build-time local copy: git-ignored (`.cache/` in .gitignore), outside data/ and public/. */
export const PRIVATE_EVENTS_CACHE_DIR = path.join(REPO_ROOT, '.cache', 'private-events');
export const EVENTFROG_SNAPSHOT_CACHE_PATH = path.join(PRIVATE_EVENTS_CACHE_DIR, 'eventfrog-ti.json');

/**
 * Daily sync at 05:40 UTC plus two hours of scheduler/runtime slack. Past this
 * the build publishes no Eventfrog page at all.
 */
export const SNAPSHOT_MAX_AGE_HOURS = 26;
export const SNAPSHOT_SCHEMA_VERSION = 1;

/** The Remote Config switch, strict: only the string `true` turns the source on. */
export function isEventfrogEnabled(env = process.env) {
  return String(env.EVENTFROG_ENABLED ?? '').trim().toLowerCase() === 'true';
}

/**
 * Build the snapshot document. `events` must already be mapped by
 * scripts/lib/eventfrog.mjs (no description, no image URL).
 */
export function buildSnapshot({ events, fetchedAt, counts }) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    source: 'eventfrog',
    scope: 'TI',
    fetchedAt,
    counts,
    events,
  };
}

/** Parse + validate a snapshot document; null when unusable. */
export function parseSnapshot(raw) {
  let doc = raw;
  if (typeof raw === 'string') {
    try {
      doc = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!doc || doc.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || doc.source !== 'eventfrog' || doc.scope !== 'TI') return null;
  if (!Array.isArray(doc.events) || typeof doc.fetchedAt !== 'string' || Number.isNaN(Date.parse(doc.fetchedAt))) return null;
  return doc;
}

/** Whether the snapshot was fetched within SNAPSHOT_MAX_AGE_HOURS of `nowMs`. */
export function isSnapshotFresh(doc, nowMs = Date.now()) {
  const fetched = Date.parse(doc?.fetchedAt ?? '');
  if (!Number.isFinite(fetched)) return false;
  const ageMs = nowMs - fetched;
  return ageMs >= -5 * 60_000 && ageMs <= SNAPSHOT_MAX_AGE_HOURS * 3_600_000;
}

function fuzzyKey(event) {
  return `${normalizeText(event.title)}|${event.startDate}|${normalizeText(event.comune || '')}`;
}

function slugKey(event) {
  return `${String(event.canton || '').toUpperCase()}|${normalizeText(event.comune || '')}|${slugifyEvent(event)}`;
}

function historicalSlugKey(route, event) {
  if (!route || typeof route !== 'object') return null;
  const slug = typeof route.slug === 'string' ? route.slug.trim() : '';
  if (!slug) return null;
  const canton = typeof route.canton === 'string' && route.canton.trim() ? route.canton : event?.canton;
  const comune = typeof route.comune === 'string' && route.comune.trim() ? route.comune : event?.comune;
  return `${String(canton || '').toUpperCase()}|${normalizeText(comune || '')}|${slug}`;
}

/**
 * Snapshot events that may get a page next to the public dataset.
 *
 * Dropped, in this order:
 *   1. anything that is not a private-source record (defense in depth);
 *   2. events already ended at `dateStamp` (no archive, no bridge page);
 *   3. events the public dataset already has — same normalized title, start
 *      date and comune as `fuzzyDedupKey` of assemble-events-dataset.mjs
 *      (tio-agenda, classicAscona and every other public source): the page
 *      stays the public source's;
 *   4. events whose detail slug would equal a public event's current or
 *      historical route in the same canton and comune, past events included,
 *      so a public URL can never be displaced or shadowed by an ephemeral page.
 *
 * @param {{ snapshotEvents: any[], publicEvents: any[], dateStamp: string }} params
 * @returns {{ events: any[], counts: { snapshot: number, upcoming: number, duplicates: number, slugCollisions: number } }}
 */
export function selectEphemeralEvents({ snapshotEvents, publicEvents, dateStamp }) {
  const candidates = (Array.isArray(snapshotEvents) ? snapshotEvents : []).filter(isPrivateEventRecord);
  // upcomingEvents sorts by startDate, title and id, so the first record for a
  // generated slug is deterministic even when the snapshot array is shuffled.
  const upcoming = upcomingEvents(candidates, dateStamp);
  const publicFuzzy = new Set();
  const publicSlugs = new Set();
  for (const event of Array.isArray(publicEvents) ? publicEvents : []) {
    if (!event) continue;
    if (typeof event.title === 'string' && typeof event.startDate === 'string') {
      publicFuzzy.add(fuzzyKey(event));
      publicSlugs.add(slugKey(event));
    }
    for (const route of Array.isArray(event.previousRoutes) ? event.previousRoutes : []) {
      const key = historicalSlugKey(route, event);
      if (key) publicSlugs.add(key);
    }
  }
  let duplicates = 0;
  let slugCollisions = 0;
  const claimedSlugs = new Set(publicSlugs);
  const events = [];
  for (const event of upcoming) {
    if (publicFuzzy.has(fuzzyKey(event))) {
      duplicates += 1;
      continue;
    }
    const key = slugKey(event);
    if (claimedSlugs.has(key)) {
      slugCollisions += 1;
      continue;
    }
    claimedSlugs.add(key);
    events.push({ ...event, ephemeral: true });
  }
  return { events, counts: { snapshot: candidates.length, upcoming: upcoming.length, duplicates, slugCollisions } };
}

/**
 * The ephemeral events the page builder may render on this build, or [] when
 * the switch is off, the file is missing, malformed or stale.
 *
 * @param {{ publicEvents: any[], dateStamp: string, env?: Record<string,string|undefined>, nowMs?: number, file?: string, log?: (msg: string) => void }} params
 */
export function loadEphemeralEvents({ publicEvents, dateStamp, env = process.env, nowMs = Date.now(), file = EVENTFROG_SNAPSHOT_CACHE_PATH, log = () => {} }) {
  if (!isEventfrogEnabled(env)) {
    log('eventfrog: EVENTFROG_ENABLED is not true — no ephemeral pages');
    return [];
  }
  if (!fs.existsSync(file)) {
    log('eventfrog: no private snapshot on this runner — no ephemeral pages');
    return [];
  }
  const doc = parseSnapshot(fs.readFileSync(file, 'utf8'));
  if (!doc) {
    log('eventfrog: private snapshot unreadable — no ephemeral pages');
    return [];
  }
  if (!isSnapshotFresh(doc, nowMs)) {
    log(`eventfrog: private snapshot older than ${SNAPSHOT_MAX_AGE_HOURS}h — no ephemeral pages`);
    return [];
  }
  const { events, counts } = selectEphemeralEvents({ snapshotEvents: doc.events, publicEvents, dateStamp });
  log(
    `eventfrog: ${events.length} ephemeral page event(s) (snapshot ${counts.snapshot}, upcoming ${counts.upcoming}, `
      + `public duplicates ${counts.duplicates}, slug collisions ${counts.slugCollisions})`,
  );
  return events;
}

/** Admin SDK bucket handle (lazy: the page builder never loads firebase-admin). */
export async function privateEventsBucket() {
  const { getFirestoreDb } = await import('./firestore-admin.mjs');
  await getFirestoreDb();
  const { getStorage } = await import('firebase-admin/storage');
  return getStorage().bucket(PRIVATE_EVENTS_BUCKET);
}

/** Read the stored snapshot, or null when absent/unreadable. */
export async function downloadSnapshot(bucket, object = EVENTFROG_SNAPSHOT_OBJECT) {
  const file = bucket.file(object);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [content] = await file.download();
  return parseSnapshot(content.toString('utf8'));
}

/**
 * Replace the stored snapshot. No download token and no public ACL are set:
 * the object is reachable only with the service account.
 */
export async function uploadSnapshot(bucket, doc, object = EVENTFROG_SNAPSHOT_OBJECT) {
  if (!object.startsWith(PRIVATE_EVENTS_STORAGE_PREFIX)) {
    throw new Error(`refusing to write a private snapshot outside ${PRIVATE_EVENTS_STORAGE_PREFIX}`);
  }
  await bucket.file(object).save(`${JSON.stringify(doc)}\n`, {
    resumable: false,
    contentType: 'application/json',
    metadata: { cacheControl: 'private, no-store' },
  });
}
