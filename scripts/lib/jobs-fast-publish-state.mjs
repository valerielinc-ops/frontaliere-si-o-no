import { createHash } from "node:crypto";
import fs from "node:fs";
import { getFirestoreDb } from "./firestore-admin.mjs";

const COLLECTION = "ciJobsFastPublishState";
const META_ID = "meta";
const BUCKET_COUNT = 256;
const DEFAULT_BOOTSTRAP_DAYS = 7;
const VOLATILE_FIELDS = new Set([
  "crawledAt",
  "lastCrawledAt",
  "scrapedAt",
  "updatedAt",
  "lastCheckedAt",
  "crawlRunId",
]);

function bucketIndex(id) {
  return Number.parseInt(
    createHash("sha256").update(id).digest("hex").slice(0, 2),
    16,
  );
}

function stateKey(id) {
  return Buffer.from(id).toString("base64url");
}

function canonicalJobValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJobValue);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (VOLATILE_FIELDS.has(key)) continue;
    out[key] = canonicalJobValue(value[key]);
  }
  return out;
}

export function fastPublishJobFingerprint(job) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJobValue(job)))
    .digest("hex");
}

function listingDateMs(job) {
  const candidates = [
    job?.postingDateSource === "reported" ? job?.datePosted : null,
    job?.postingDateSource === "reported" ? job?.postedDate : null,
    job?.firstSeenAt,
  ];
  const times = candidates
    .map((candidate) => {
      const time = Date.parse(String(candidate || ""));
      return Number.isFinite(time) && time >= Date.UTC(2000, 0, 1)
        ? time
        : null;
    })
    .filter((time) => time !== null);
  return times.length ? Math.max(...times) : null;
}

function crawlTimestampMs(job) {
  for (const value of [
    job?.lastCrawledAt,
    job?.crawledAt,
    job?.lastCheckedAt,
  ]) {
    if (value === null || value === undefined || value === "") continue;
    const numeric = Number(value);
    const parsed = Number.isFinite(numeric)
      ? numeric >= 1_000_000_000_000
        ? numeric
        : numeric >= 1_000_000_000
          ? numeric * 1000
          : NaN
      : Date.parse(String(value));
    if (Number.isFinite(parsed) && parsed >= Date.UTC(2000, 0, 1))
      return parsed;
  }
  return null;
}

function bucketDoc(db, index) {
  return db
    .collection(COLLECTION)
    .doc(`bucket-${index.toString(16).padStart(2, "0")}`);
}

function publishedHash(value) {
  return typeof value === "string" ? value : String(value?.hash || "");
}

function publishedPaths(value) {
  return Array.isArray(value?.paths)
    ? value.paths.filter((path) => typeof path === "string")
    : [];
}

function samePaths(left, right) {
  const normalize = (paths) =>
    [
      ...new Set(
        Array.isArray(paths)
          ? paths.filter((path) => typeof path === "string")
          : [],
      ),
    ].sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

async function bootstrapCutoff(db, now, bootstrapDays, write) {
  const meta = db.collection(COLLECTION).doc(META_ID);
  const suggested = now - bootstrapDays * 86_400_000;
  if (!write) {
    const snapshot = await meta.get();
    return snapshot.exists
      ? (snapshot.data()?.bootstrapCutoffMs ?? suggested)
      : suggested;
  }
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(meta);
    const cutoff = snapshot.exists
      ? snapshot.data()?.bootstrapCutoffMs
      : undefined;
    if (Number.isSafeInteger(cutoff)) return cutoff;
    transaction.set(meta, {
      bootstrapCutoffMs: suggested,
      bootstrapDays,
      createdAtMs: now,
    });
    return suggested;
  });
}

/**
 * Compare current active jobs with a Firestore manifest and queue changed IDs.
 * Dry-run mode reads the same durable snapshot but makes no writes.
 */
export async function discoverFastPublishJobs(
  jobs,
  {
    write = false,
    bootstrapDays = DEFAULT_BOOTSTRAP_DAYS,
    now = Date.now(),
    db,
    pathsForJob,
  } = {},
) {
  if (!Array.isArray(jobs))
    throw new Error("[jobs-fast-state] jobs must be an array");
  if (
    !Number.isSafeInteger(bootstrapDays) ||
    bootstrapDays < 1 ||
    bootstrapDays > 30
  ) {
    throw new Error(
      "[jobs-fast-state] bootstrapDays must be an integer from 1 to 30",
    );
  }
  const firestore = db || (await getFirestoreDb());
  const cutoff = await bootstrapCutoff(firestore, now, bootstrapDays, write);
  const activeByBucket = Array.from({ length: BUCKET_COUNT }, () => new Map());
  const currentById = new Map();
  const canonicalPathsById = new Map();
  for (const job of jobs) {
    const id = String(job?.stableId || job?.id || job?.slug || "").trim();
    if (!id) continue;
    if (currentById.has(id))
      throw new Error(
        `[jobs-fast-state] duplicate stable job ID in active corpus: ${id}`,
      );
    const hash = fastPublishJobFingerprint(job);
    const row = {
      id,
      hash,
      observedAtMs: listingDateMs(job) ?? now,
      crawlAtMs: crawlTimestampMs(job),
    };
    currentById.set(id, { job, ...row });
    if (typeof pathsForJob === "function") {
      const paths = pathsForJob(job);
      if (
        !Array.isArray(paths) ||
        paths.some(
          (path) =>
            typeof path !== "string" ||
            !path.startsWith("/") ||
            !path.endsWith("/"),
        )
      ) {
        throw new Error(
          `[jobs-fast-state] canonical paths are invalid for ${id}`,
        );
      }
      canonicalPathsById.set(id, [...new Set(paths)].sort());
    }
    activeByBucket[bucketIndex(id)].set(stateKey(id), row);
  }

  const pending = [];
  for (let index = 0; index < BUCKET_COUNT; index++) {
    const ref = bucketDoc(firestore, index);
    const current = activeByBucket[index];
    let resultRows;
    let publishedRows = {};
    const reconcile = async (transaction) => {
      const snapshot = await transaction.get(ref);
      const data = snapshot.exists ? snapshot.data() : {};
      const published = { ...(data.published || {}) };
      publishedRows = published;
      const queued = { ...(data.pending || {}) };
      let changed = !snapshot.exists;
      for (const [key, record] of Object.entries(queued)) {
        if (!current.has(key)) {
          delete queued[key];
          changed = true;
        }
      }
      for (const [key, record] of current) {
        const previousHash = publishedHash(published[key]);
        const hasCanonicalPaths = canonicalPathsById.has(record.id);
        const currentPaths = canonicalPathsById.get(record.id);
        const previous = queued[key];
        // Keep the latest full-build ownership set pending until it is rendered.
        // A zero-page offer cannot be rendered now, but a later route gain must
        // not be hidden by the stale paths of its last published page.
        const ownershipChangePending =
          hasCanonicalPaths && previous?.ownershipChangePending === true;
        const pathsChanged =
          hasCanonicalPaths &&
          !samePaths(currentPaths, publishedPaths(published[key]));
        if (
          previousHash === record.hash &&
          !pathsChanged &&
          !ownershipChangePending
        ) {
          if (queued[key]) {
            delete queued[key];
            changed = true;
          }
          continue;
        }
        const isNew = previousHash === "";
        if (isNew && record.observedAtMs < cutoff) {
          const hadQueued = Boolean(queued[key]);
          if (write) {
            const paths = canonicalPathsById.get(record.id);
            if (!paths)
              throw new Error(
                `[jobs-fast-state] pathsForJob is required to bootstrap pre-cutoff job ${record.id}`,
              );
            published[key] = {
              hash: record.hash,
              paths,
              publishedAtMs: now,
            };
          }
          if (hadQueued) delete queued[key];
          changed ||= write || hadQueued;
          continue;
        }
        const next = {
          id: record.id,
          hash: record.hash,
          observedAtMs: record.observedAtMs,
        };
        if (hasCanonicalPaths && (pathsChanged || ownershipChangePending)) {
          next.paths = currentPaths;
          next.ownershipChangePending = true;
        }
        if (
          !previous ||
          previous.hash !== next.hash ||
          previous.observedAtMs !== next.observedAtMs ||
          previous.ownershipChangePending !== next.ownershipChangePending ||
          (next.ownershipChangePending && !samePaths(previous.paths, next.paths))
        ) {
          queued[key] = next;
          changed = true;
        }
      }
      resultRows = Object.values(queued);
      if (write && changed) {
        transaction.set(ref, {
          published,
          pending: queued,
          updatedAtMs: now,
          schema: "jobs-fast-publish-state/v1",
        });
      }
    };
    if (write) await firestore.runTransaction(reconcile);
    else {
      const snapshot = await ref.get();
      const data = snapshot.exists ? snapshot.data() : {};
      const published = data.published || {};
      publishedRows = published;
      const queued = { ...(data.pending || {}) };
      for (const [key, record] of Object.entries(queued))
        if (!current.has(key)) delete queued[key];
      for (const [key, record] of current) {
        const previousHash = publishedHash(published[key]);
        const hasCanonicalPaths = canonicalPathsById.has(record.id);
        const currentPaths = canonicalPathsById.get(record.id);
        const previous = queued[key];
        const ownershipChangePending =
          hasCanonicalPaths && previous?.ownershipChangePending === true;
        const pathsChanged =
          hasCanonicalPaths &&
          !samePaths(currentPaths, publishedPaths(published[key]));
        if (
          previousHash === record.hash &&
          !pathsChanged &&
          !ownershipChangePending
        )
          delete queued[key];
        else if (previousHash === "" && record.observedAtMs < cutoff)
          delete queued[key];
        else {
          const next = {
            id: record.id,
            hash: record.hash,
            observedAtMs: record.observedAtMs,
          };
          if (hasCanonicalPaths && (pathsChanged || ownershipChangePending)) {
            next.paths = currentPaths;
            next.ownershipChangePending = true;
          }
          queued[key] = next;
        }
      }
      resultRows = Object.values(queued);
    }
    for (const row of resultRows || []) {
      const currentJob = currentById.get(row.id);
      if (currentJob && row.hash === currentJob.hash) {
        const currentPaths = canonicalPathsById.get(row.id);
        // Leave a zero-page ownership marker durable; a later gain makes the
        // marker renderable even when the old published path set is identical.
        if (
          row.ownershipChangePending === true &&
          canonicalPathsById.has(row.id) &&
          currentPaths.length === 0 &&
          samePaths(currentPaths, row.paths)
        ) {
          continue;
        }
        pending.push({
          ...currentJob,
          previousPaths: publishedPaths(publishedRows[stateKey(row.id)]),
        });
      }
    }
  }
  const distinct = new Map(pending.map((row) => [row.id, row]));
  return [...distinct.values()].sort(
    (a, b) => a.observedAtMs - b.observedAtMs || a.id.localeCompare(b.id),
  );
}

/** Mark only the exact fingerprints just published as the durable baseline. */
export async function markFastPublishJobsPublished(records, { db } = {}) {
  if (!Array.isArray(records) || records.length === 0) return;
  const firestore = db || (await getFirestoreDb());
  const grouped = new Map();
  for (const record of records) {
    const id = String(record?.id || "").trim();
    const hash = String(record?.hash || "").trim();
    if (!id || !/^[a-f0-9]{64}$/u.test(hash))
      throw new Error("[jobs-fast-state] invalid published receipt");
    if (
      !Array.isArray(record?.paths) ||
      record.paths.some(
        (path) => typeof path !== "string" || !path.startsWith("/"),
      )
    ) {
      throw new Error(
        "[jobs-fast-state] published receipt must include canonical paths",
      );
    }
    const index = bucketIndex(id);
    if (!grouped.has(index)) grouped.set(index, []);
    grouped.get(index).push({
      id,
      hash,
      paths: [...new Set(record.paths)].sort(),
      key: stateKey(id),
    });
  }
  for (const [index, rows] of grouped) {
    const ref = bucketDoc(firestore, index);
    await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const data = snapshot.exists ? snapshot.data() : {};
      const published = { ...(data.published || {}) };
      const pending = { ...(data.pending || {}) };
      for (const row of rows) {
        if (pending[row.key]?.hash !== row.hash) continue;
        if (
          pending[row.key]?.ownershipChangePending === true &&
          !samePaths(pending[row.key].paths, row.paths)
        ) {
          continue;
        }
        published[row.key] = {
          hash: row.hash,
          paths: row.paths,
          publishedAtMs: Date.now(),
        };
        delete pending[row.key];
      }
      transaction.set(ref, {
        published,
        pending,
        updatedAtMs: Date.now(),
        schema: "jobs-fast-publish-state/v1",
      });
    });
  }
}

export const JOBS_FAST_PUBLISH_STATE_DEFAULTS = Object.freeze({
  bootstrapDays: DEFAULT_BOOTSTRAP_DAYS,
  buckets: BUCKET_COUNT,
});
