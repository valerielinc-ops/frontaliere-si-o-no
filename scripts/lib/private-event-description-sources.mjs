/**
 * Admin-SDK-only store for the source descriptions that feed the rewrite queue.
 * The prefix is denied to Firebase clients in storage.rules; it is never part
 * of a build artifact, public dataset or CDN upload.
 */

import fs from 'node:fs';
import path from 'node:path';
import { privateEventsBucket } from './private-event-snapshots.mjs';

export const PRIVATE_EVENT_DESCRIPTION_STORAGE_PREFIX = 'private-event-description-sources/';
export const EVENT_DESCRIPTION_BACKLOG_OBJECT = `${PRIVATE_EVENT_DESCRIPTION_STORAGE_PREFIX}backlog.jsonl`;

export async function downloadPrivateEventDescriptionSources(bucket, object = EVENT_DESCRIPTION_BACKLOG_OBJECT) {
  if (!object.startsWith(PRIVATE_EVENT_DESCRIPTION_STORAGE_PREFIX)) {
    throw new Error(`refusing to read outside ${PRIVATE_EVENT_DESCRIPTION_STORAGE_PREFIX}`);
  }
  const file = bucket.file(object);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [content] = await file.download();
  return content;
}

export async function uploadPrivateEventDescriptionSources(
  bucket,
  content,
  object = EVENT_DESCRIPTION_BACKLOG_OBJECT,
) {
  if (!object.startsWith(PRIVATE_EVENT_DESCRIPTION_STORAGE_PREFIX)) {
    throw new Error(`refusing to write outside ${PRIVATE_EVENT_DESCRIPTION_STORAGE_PREFIX}`);
  }
  const payload = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  await bucket.file(object).save(payload, {
    resumable: false,
    contentType: 'application/x-ndjson',
    metadata: { cacheControl: 'private, no-store' },
  });
}

export async function privateEventDescriptionBucket() {
  return privateEventsBucket();
}

export function isAllowedPrivateEventDescriptionOutput(file) {
  const resolved = path.resolve(file);
  const roots = [path.resolve(process.env.RUNNER_TEMP || '/tmp'), path.resolve(process.cwd(), '.cache')];
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

export function writePrivateEventDescriptionOutput(file, content) {
  if (!isAllowedPrivateEventDescriptionOutput(file)) {
    throw new Error('private event-description output must stay under RUNNER_TEMP or .cache');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
}
