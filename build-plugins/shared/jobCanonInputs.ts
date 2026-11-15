/** In-process and staged-build handoff for ordering fields omitted from the public slug map. */
export const JOB_CANON_ORDERING_FIELDS_FILE_NAME = 'job-canon-ordering-fields.json';

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

let orderingFieldsById: ReadonlyMap<string, JobCanonOrderingFields> | null = null;

export type JobCanonOrderingFieldsEntry = readonly [string, JobCanonOrderingFields];

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

/** Serialize the compact map so the bundle and SSG build processes can share it. */
export function serializeJobCanonOrderingFields(): JobCanonOrderingFieldsEntry[] | null {
  return orderingFieldsById ? Array.from(orderingFieldsById.entries()) : null;
}

/** Parse the staged handoff without accepting malformed or duplicate keys. */
export function parseJobCanonOrderingFields(value: unknown): ReadonlyMap<string, JobCanonOrderingFields> | null {
  if (!Array.isArray(value)) return null;

  const fieldsById = new Map<string, JobCanonOrderingFields>();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [id, rawFields] = entry as unknown[];
    if (typeof id !== 'string' || !id || id.trim() !== id) return null;
    if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) return null;

    const record = rawFields as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'datePosted' && key !== 'firstSeenAt')) return null;
    if (fieldsById.has(id)) return null;

    const fields: JobCanonOrderingFields = {};
    if (Object.prototype.hasOwnProperty.call(record, 'datePosted')) fields.datePosted = record.datePosted;
    if (Object.prototype.hasOwnProperty.call(record, 'firstSeenAt')) fields.firstSeenAt = record.firstSeenAt;
    fieldsById.set(id, fields);
  }
  return fieldsById;
}

export function clearJobCanonOrderingFields(): void {
  orderingFieldsById = null;
}
