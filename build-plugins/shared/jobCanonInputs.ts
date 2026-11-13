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

/** Null means the locale split producer has not run in this Vite process. */
export function getJobCanonOrderingFields(): ReadonlyMap<string, JobCanonOrderingFields> | null {
  return orderingFieldsById;
}

export function clearJobCanonOrderingFields(): void {
  orderingFieldsById = null;
}
