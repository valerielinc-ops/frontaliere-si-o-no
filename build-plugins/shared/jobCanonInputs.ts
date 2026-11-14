import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/** Small build-process handoff for the durable ordering fields omitted from the public slug map. */
export interface JobCanonOrderingInput {
  id?: unknown;
  slug?: unknown;
  datePosted?: unknown;
  firstSeenAt?: unknown;
}

export interface JobCanonOrderingFields {
  datePosted?: unknown;
  firstSeenAt?: unknown;
}

interface JobCanonOrderingHandoffRow extends JobCanonOrderingFields {
  id: string;
}

const HANDOFF_SCHEMA_VERSION = 1;
const HANDOFF_FILE_NAME = 'job-canon-ordering-fields.json';

let orderingFieldsById: ReadonlyMap<string, JobCanonOrderingFields> | null = null;

/** Keep only the two sort fields and stable key; never retain full job records. */
export function setJobCanonOrderingFields(jobs: readonly JobCanonOrderingInput[]): void {
  const fieldsById = new Map<string, JobCanonOrderingFields>();
  for (const job of jobs) {
    const id = String(job.id || job.slug || '').trim();
    if (!id || fieldsById.has(id)) continue;
    fieldsById.set(id, {
      ...(job.datePosted !== undefined ? { datePosted: job.datePosted } : {}),
      ...(job.firstSeenAt !== undefined ? { firstSeenAt: job.firstSeenAt } : {}),
    });
  }
  orderingFieldsById = fieldsById;
}

/** Null means the locale split producer has not run in this Vite process. */
export function getJobCanonOrderingFields(): ReadonlyMap<string, JobCanonOrderingFields> | null {
  return orderingFieldsById;
}

export function clearJobCanonOrderingFields(): void {
  orderingFieldsById = null;
}

export function jobCanonOrderingHandoffPath(rootDir: string): string {
  return path.resolve(rootDir, '.cache', HANDOFF_FILE_NAME);
}

/** Hash a large source file with bounded memory so an old handoff cannot be reused. */
export function sha256FileSync(filePath: string): string {
  const descriptor = fs.openSync(filePath, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

/** Write only stable identity and the two sort fields, using an atomic rename. */
export function writeJobCanonOrderingHandoff(filePath: string, sourceSha256: string): void {
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) {
    throw new Error('[job-canon-ordering-handoff] source digest must be a SHA-256 hex string');
  }
  if (!orderingFieldsById) {
    throw new Error('[job-canon-ordering-handoff] producer has no ordering fields to persist');
  }

  const rows: JobCanonOrderingHandoffRow[] = [];
  for (const [id, fields] of orderingFieldsById) {
    rows.push({
      id,
      ...(Object.prototype.hasOwnProperty.call(fields, 'datePosted') ? { datePosted: fields.datePosted } : {}),
      ...(Object.prototype.hasOwnProperty.call(fields, 'firstSeenAt') ? { firstSeenAt: fields.firstSeenAt } : {}),
    });
  }
  const rowsJson = JSON.stringify(rows);
  const document = JSON.stringify({
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    sourceSha256,
    rowsSha256: createHash('sha256').update(rowsJson).digest('hex'),
    rows,
  });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(temporaryPath, document, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** Read and consume a staged handoff, validating both its payload and source identity. */
export function consumeJobCanonOrderingHandoff(
  filePath: string,
  sourcePath: string,
  rootDir: string,
): ReadonlyMap<string, JobCanonOrderingFields> {
  try {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `[job-canon-redirect-map] missing build ordering handoff: ${path.relative(rootDir, filePath)}`,
        );
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('[job-canon-redirect-map] invalid build ordering handoff JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('[job-canon-redirect-map] invalid build ordering handoff document');
    }

    const document = parsed as Record<string, unknown>;
    const documentKeys = Object.keys(document).sort();
    if (
      documentKeys.join(',') !== 'rows,rowsSha256,schemaVersion,sourceSha256'
      || document.schemaVersion !== HANDOFF_SCHEMA_VERSION
      || typeof document.sourceSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(document.sourceSha256)
      || typeof document.rowsSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(document.rowsSha256)
      || !Array.isArray(document.rows)
    ) {
      throw new Error('[job-canon-redirect-map] invalid build ordering handoff schema');
    }

    const rowsJson = JSON.stringify(document.rows);
    if (createHash('sha256').update(rowsJson).digest('hex') !== document.rowsSha256) {
      throw new Error('[job-canon-redirect-map] build ordering handoff checksum mismatch');
    }
    if (sha256FileSync(sourcePath) !== document.sourceSha256) {
      throw new Error('[job-canon-redirect-map] build ordering handoff source does not match data/jobs.json');
    }

    const fieldsById = new Map<string, JobCanonOrderingFields>();
    for (const value of document.rows) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('[job-canon-redirect-map] invalid row in build ordering handoff');
      }
      const row = value as Record<string, unknown>;
      const rowKeys = Object.keys(row).sort();
      if (
        typeof row.id !== 'string'
        || !row.id
        || row.id !== row.id.trim()
        || rowKeys.some((key) => !['datePosted', 'firstSeenAt', 'id'].includes(key))
        || fieldsById.has(row.id)
      ) {
        throw new Error('[job-canon-redirect-map] invalid or duplicate identity in build ordering handoff');
      }
      fieldsById.set(row.id, {
        ...(Object.prototype.hasOwnProperty.call(row, 'datePosted') ? { datePosted: row.datePosted } : {}),
        ...(Object.prototype.hasOwnProperty.call(row, 'firstSeenAt') ? { firstSeenAt: row.firstSeenAt } : {}),
      });
    }
    return fieldsById;
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
