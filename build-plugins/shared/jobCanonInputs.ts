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

/** Serialize the compact sort handoff for the separate SSG build process. */
export function serializeJobCanonOrderingFields(): string {
  if (!orderingFieldsById) throw new Error('job-canon ordering fields are not initialized');
  return JSON.stringify(Array.from(orderingFieldsById.entries()));
}

/** Restore the sort handoff emitted by the bundle-stage locale splitter. */
export function restoreJobCanonOrderingFields(serialized: string): void {
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) throw new Error('job-canon ordering handoff must be an array');

  const fieldsById = new Map<string, JobCanonOrderingFields>();
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0]
        || !entry[1] || typeof entry[1] !== 'object' || Array.isArray(entry[1])) {
      throw new Error('job-canon ordering handoff contains an invalid entry');
    }
    const fields = entry[1] as Record<string, unknown>;
    fieldsById.set(entry[0], {
      ...(fields.datePosted !== undefined ? { datePosted: fields.datePosted } : {}),
      ...(fields.firstSeenAt !== undefined ? { firstSeenAt: fields.firstSeenAt } : {}),
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
