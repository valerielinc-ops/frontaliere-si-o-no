#!/usr/bin/env node
/**
 * Daily Eventfrog → private snapshot sync (Ticino). Run by crawl-events.yml.
 *
 * Writes ONE complete snapshot that replaces the previous one in the private
 * Firebase Storage object (scripts/lib/private-event-snapshots.mjs). It never
 * writes data/events/**, data/events.json or public/** — those are public —
 * and it prints counts only: Actions logs are as public as the repository.
 *
 * No-op with a `::notice::` when the Remote Config switch EVENTFROG_ENABLED is
 * not `true` or when EVENTFROG_PUBLIC_API_KEY is missing.
 *
 * Exit 1 (previous snapshot kept, and it ages out of the build after
 * SNAPSHOT_MAX_AGE_HOURS) when the API answer is incomplete or unreadable.
 * There is deliberately NO "contraction gate" that keeps the old snapshot when
 * the new one is smaller: an event Eventfrog no longer returns may not be
 * published any more (AGB §17(5)), so a smaller complete answer is the truth.
 * A drop below CONTRACTION_WARN_RATIO only raises a warning.
 *
 * Usage:
 *   node scripts/sync-eventfrog-snapshot.mjs                 # sync to Storage
 *   node scripts/sync-eventfrog-snapshot.mjs --out <file>    # local file (under .cache/private-events or the OS temp dir)
 *
 * Env: EVENTFROG_ENABLED, EVENTFROG_PUBLIC_API_KEY,
 *      EVENTFROG_PUBLIC_API_KEY_EXPIRES_AT (YYYY-MM-DD, optional),
 *      GOOGLE_APPLICATION_CREDENTIALS (Storage mode), GITHUB_OUTPUT (optional).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTicinoEventfrogRecords, createRequestPacer } from './lib/eventfrog.mjs';
import {
  buildSnapshot,
  downloadSnapshot,
  isEventfrogEnabled,
  parseSnapshot,
  privateEventsBucket,
  uploadSnapshot,
  PRIVATE_EVENTS_CACHE_DIR,
} from './lib/private-event-snapshots.mjs';

export const KEY_EXPIRY_WARN_DAYS = 14;
export const CONTRACTION_WARN_RATIO = 0.8;

/** Days until the key expires (negative once expired), or null when unknown. */
export function daysUntilKeyExpiry(expiresAt, nowMs = Date.now()) {
  if (typeof expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt.trim())) return null;
  const end = Date.parse(`${expiresAt.trim()}T00:00:00Z`);
  if (!Number.isFinite(end)) return null;
  return Math.floor((end - nowMs) / 86_400_000);
}

/** A local `--out` target is accepted only under the private cache dir or the OS temp dir. */
export function isAllowedLocalOut(file) {
  const resolved = path.resolve(file);
  const roots = [PRIVATE_EVENTS_CACHE_DIR, os.tmpdir(), safeReal(os.tmpdir())];
  return roots.some((root) => resolved === root || resolved.startsWith(`${path.resolve(root)}${path.sep}`));
}

function safeReal(dir) {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}

function localFileStore(file) {
  return {
    async read() {
      return fs.existsSync(file) ? parseSnapshot(fs.readFileSync(file, 'utf8')) : null;
    },
    async write(doc) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(doc)}\n`, 'utf8');
    },
  };
}

async function storageStore() {
  const bucket = await privateEventsBucket();
  return {
    read: () => downloadSnapshot(bucket),
    write: (doc) => uploadSnapshot(bucket, doc),
  };
}

function writeOutput(env, key, value) {
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

/**
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   argv?: string[],
 *   fetchImpl?: typeof fetch,
 *   store?: { read: () => Promise<any>, write: (doc: any) => Promise<void> },
 *   nowMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (line: string) => void,
 * }} [opts]
 * @returns {Promise<{ status: 'disabled'|'no-key'|'written'|'failed', exitCode: number, counts?: object }>}
 */
export async function run(opts = {}) {
  const env = opts.env || process.env;
  const argv = opts.argv || process.argv.slice(2);
  const log = opts.log || ((line) => console.log(line));
  const nowMs = opts.nowMs ?? Date.now();

  if (!isEventfrogEnabled(env)) {
    log('::notice::[eventfrog] EVENTFROG_ENABLED is not true (Remote Config) — sync skipped.');
    return { status: 'disabled', exitCode: 0 };
  }
  const apiKey = String(env.EVENTFROG_PUBLIC_API_KEY || '').trim();
  if (!apiKey) {
    log('::notice::[eventfrog] EVENTFROG_PUBLIC_API_KEY is not set — sync skipped (owner action: create the key and store it in Remote Config).');
    return { status: 'no-key', exitCode: 0 };
  }

  const daysLeft = daysUntilKeyExpiry(env.EVENTFROG_PUBLIC_API_KEY_EXPIRES_AT, nowMs);
  if (daysLeft !== null && daysLeft <= KEY_EXPIRY_WARN_DAYS) {
    log(`::warning::[eventfrog] the Public API key expires in ${daysLeft} day(s): renew it on eventfrog.ch and update EVENTFROG_PUBLIC_API_KEY(_EXPIRES_AT) in Remote Config.`);
    writeOutput(env, 'key_expiring', 'true');
  }

  const outIndex = argv.indexOf('--out');
  let store = opts.store;
  if (!store && outIndex >= 0) {
    const out = argv[outIndex + 1];
    if (!out || !isAllowedLocalOut(out)) {
      log('::error::[eventfrog] --out must point under .cache/private-events/ or the OS temp dir (never a tracked path).');
      return { status: 'failed', exitCode: 1 };
    }
    store = localFileStore(path.resolve(out));
  }

  let result;
  try {
    result = await fetchTicinoEventfrogRecords({
      apiKey,
      fetchImpl: opts.fetchImpl,
      pacer: createRequestPacer({ sleep: opts.sleep }),
    });
  } catch (error) {
    // The message never contains the key (eventfrogGet builds it from the route and status).
    log(`::error::[eventfrog] sync failed, previous snapshot kept (it stops being published after it ages out): ${error?.message || error}`);
    return { status: 'failed', exitCode: 1 };
  }

  try {
    store ||= await storageStore();
    const previous = await store.read().catch(() => null);
    const previousCount = Array.isArray(previous?.events) ? previous.events.length : null;
    const doc = buildSnapshot({ events: result.records, fetchedAt: new Date(nowMs).toISOString(), counts: result.counts });
    await store.write(doc);
    const c = result.counts;
    const skipped = Object.entries(c.skipped).map(([k, v]) => `${k}=${v}`).join(',') || 'none';
    log(`[eventfrog] snapshot TI: ${c.kept} events (api total ${c.apiTotal}, fetched ${c.fetched}, with price ${c.withPrice}, requests ${c.requests}, skipped ${skipped}, previous ${previousCount ?? 'none'})`);
    if (previousCount && c.kept < previousCount * CONTRACTION_WARN_RATIO) {
      log(`::warning::[eventfrog] the snapshot shrank from ${previousCount} to ${c.kept} events; replaced anyway (data Eventfrog no longer returns may not be published).`);
    }
    writeOutput(env, 'events', String(c.kept));
    return { status: 'written', exitCode: 0, counts: c };
  } catch (error) {
    log(`::error::[eventfrog] could not store the private snapshot: ${error?.message || error}`);
    return { status: 'failed', exitCode: 1 };
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  run().then(
    (outcome) => process.exit(outcome.exitCode),
    (error) => {
      console.log(`::error::[eventfrog] unexpected failure: ${error?.name || 'Error'}`);
      process.exit(1);
    },
  );
}
