import { readStageHandoff, writeStageHandoff, type StageHandoffRead } from './stageHandoff';

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

/** File name inside BUILD_STAGE_HANDOFF_DIR (see shared/stageHandoff.ts). */
export const JOB_CANON_ORDERING_HANDOFF_FILE = 'job-canon-ordering-fields.json';

let orderingFieldsById: ReadonlyMap<string, JobCanonOrderingFields> | null = null;
// After clear() the map is deliberately gone: do not resurrect it from the handoff file.
let handoffLoadAttempted = false;

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
  handoffLoadAttempted = false;
  // Staged build: the SSG runs in another Vite process, so persist the same map
  // (id -> sort fields only) for it. No-op without BUILD_STAGE_HANDOFF_DIR.
  writeStageHandoff(JOB_CANON_ORDERING_HANDOFF_FILE, { version: 1, fields: Object.fromEntries(fieldsById) });
}

/** The handoff as the SSG stage sees it: missing / unreadable are reported, not hidden. */
export function readJobCanonOrderingHandoff(): StageHandoffRead<{ version: number; fields: Record<string, JobCanonOrderingFields> }> {
  return readStageHandoff(JOB_CANON_ORDERING_HANDOFF_FILE);
}

/**
 * Null means no producer ran in this process AND no usable handoff file exists.
 * In the staged build the producer (localeJobsSplitPlugin) lives in the bundle
 * process; its map is loaded once from the handoff file written by it.
 */
export function getJobCanonOrderingFields(): ReadonlyMap<string, JobCanonOrderingFields> | null {
  if (orderingFieldsById || handoffLoadAttempted) return orderingFieldsById;
  handoffLoadAttempted = true;
  const handoff = readJobCanonOrderingHandoff();
  if (handoff.status === 'ok' && handoff.data && typeof handoff.data.fields === 'object' && handoff.data.fields) {
    orderingFieldsById = new Map(Object.entries(handoff.data.fields));
  }
  return orderingFieldsById;
}

export function clearJobCanonOrderingFields(): void {
  orderingFieldsById = null;
  handoffLoadAttempted = true;
}
