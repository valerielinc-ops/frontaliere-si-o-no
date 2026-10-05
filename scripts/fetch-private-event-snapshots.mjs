#!/usr/bin/env node
/**
 * Build-time download of the private Eventfrog snapshot (deploy.yml, before
 * the build of every locale shard).
 *
 * Copies gs://<bucket>/private-event-snapshots/eventfrog-ti.json to
 * .cache/private-events/eventfrog-ti.json — git-ignored, outside data/ and
 * public/, so it is neither committed nor copied into dist/. The events page
 * builder then decides freshness and dedup (scripts/lib/private-event-snapshots.mjs).
 *
 * Never fails the deploy: with the switch off, no credentials or any error, it
 * REMOVES a stale local copy and exits 0, and the build simply emits no
 * Eventfrog page (the pages of the previous deploy are then removed by the
 * shard push, which is the compliant direction of failure). Prints counts only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVENTFROG_SNAPSHOT_CACHE_PATH,
  downloadSnapshot,
  isEventfrogEnabled,
  privateEventsBucket,
} from './lib/private-event-snapshots.mjs';

/**
 * @param {{ env?: Record<string,string|undefined>, file?: string, download?: () => Promise<any>, log?: (l: string) => void }} [opts]
 */
export async function run(opts = {}) {
  const env = opts.env || process.env;
  const file = opts.file || EVENTFROG_SNAPSHOT_CACHE_PATH;
  const log = opts.log || ((line) => console.log(line));
  fs.rmSync(file, { force: true });
  if (!isEventfrogEnabled(env)) {
    log('::notice::[eventfrog] EVENTFROG_ENABLED is not true — no private snapshot for this build.');
    return { status: 'disabled' };
  }
  try {
    const download = opts.download || (async () => downloadSnapshot(await privateEventsBucket()));
    const doc = await download();
    if (!doc) {
      log('::notice::[eventfrog] no private snapshot stored yet — this build emits no Eventfrog page.');
      return { status: 'missing' };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(doc)}\n`, 'utf8');
    log(`[eventfrog] private snapshot ready: ${doc.events.length} events, fetched ${doc.fetchedAt}`);
    return { status: 'ready', events: doc.events.length };
  } catch (error) {
    fs.rmSync(file, { force: true });
    log(`::warning::[eventfrog] private snapshot unavailable (${error?.name || 'Error'}) — this build emits no Eventfrog page.`);
    return { status: 'error' };
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  run().then(() => process.exit(0), () => process.exit(0));
}
