import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { getFirestoreDb } from "./firestore-admin.mjs";

const COLLECTION = "ciShardWriterLeases";
const LEASE_MS = 120_000;
const POLL_MS = 3_000;
const HEARTBEAT_MS = 30_000;
const SECTION_SLUGS = Object.freeze(
  Object.keys(
    JSON.parse(
      fs.readFileSync(
        new URL("./section-shard-slugs.json", import.meta.url),
        "utf8",
      ),
    ),
  ),
);

function normalizeScope(scope) {
  const section = String(scope?.section || "").trim();
  const locale = String(scope?.locale || "").trim();
  if (!(SECTION_SLUGS.includes(section) || section === "__sitemaps__")) {
    throw new Error(
      `[shard-writer] unsupported section scope: ${section || "(empty)"}`,
    );
  }
  if (!["it", "en", "de", "fr"].includes(locale)) {
    throw new Error(
      `[shard-writer] unsupported locale scope: ${locale || "(empty)"}`,
    );
  }
  return { section, locale, key: `${section}:${locale}` };
}

function docId(scope) {
  return createHash("sha256").update(scope.key).digest("hex").slice(0, 40);
}

function asLease(snapshot) {
  if (!snapshot?.exists) return null;
  const lease = snapshot.data();
  if (
    !lease ||
    typeof lease.owner !== "string" ||
    typeof lease.leaseId !== "string" ||
    !Number.isSafeInteger(lease.expiresAtMs) ||
    typeof lease.scope !== "string"
  ) {
    throw new Error(
      `[shard-writer] invalid lease record for ${snapshot.id}; refusing unsafe takeover`,
    );
  }
  return lease;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Acquire a sorted set of section/locale leases atomically. */
export async function acquireShardWriterLeases(scopes, options = {}) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error(
      "[shard-writer] at least one section/locale scope is required",
    );
  }
  const normalized = [
    ...new Map(
      scopes.map((scope) => {
        const value = normalizeScope(scope);
        return [value.key, value];
      }),
    ).values(),
  ].sort((a, b) => a.key.localeCompare(b.key));
  if (normalized.length > 450)
    throw new Error(
      "[shard-writer] lease set exceeds the 450-scope safety cap",
    );
  const policy = options.policy || "wait";
  if (policy !== "wait" && policy !== "skip")
    throw new Error("[shard-writer] policy must be wait or skip");
  const owner =
    options.owner ||
    `${process.env.GITHUB_RUN_ID || "local"}:${process.env.GITHUB_RUN_ATTEMPT || "1"}:${process.pid}:${randomUUID()}`;
  const leaseMs = options.leaseMs ?? LEASE_MS;
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const pollMs = options.pollMs ?? POLL_MS;
  const now = options.now || Date.now;
  const sleep = options.sleep || delay;
  const db = options.db || (await getFirestoreDb());
  const collection = db.collection(COLLECTION);
  const candidates = normalized.map((scope) => ({
    ...scope,
    owner,
    leaseId: randomUUID(),
    acquiredAtMs: now(),
    expiresAtMs: now() + leaseMs,
    ref: collection.doc(docId(scope)),
  }));
  const deadline = now() + timeoutMs;
  let reportedBusy = false;

  while (true) {
    const result = await db.runTransaction(async (tx) => {
      const snapshots = [];
      for (const candidate of candidates)
        snapshots.push(await tx.get(candidate.ref));
      const currentTime = now();
      const busy = snapshots.flatMap((snapshot, index) => {
        const lease = asLease(snapshot);
        return lease && lease.expiresAtMs > currentTime
          ? [candidates[index].key]
          : [];
      });
      if (busy.length > 0) return { acquired: false, busy };
      for (const candidate of candidates) {
        tx.set(candidate.ref, {
          scope: candidate.key,
          section: candidate.section,
          locale: candidate.locale,
          owner,
          leaseId: candidate.leaseId,
          acquiredAtMs: currentTime,
          expiresAtMs: currentTime + leaseMs,
        });
      }
      return { acquired: true, busy: [] };
    });

    if (result.acquired) {
      const locks = candidates.map(
        ({ section, locale, key, owner: lockOwner, leaseId }) => ({
          section,
          locale,
          key,
          owner: lockOwner,
          leaseId,
        }),
      );
      console.log(
        `[shard-writer] acquired scopes=${locks.map((lock) => lock.key).join(",")}`,
      );
      return { acquired: true, owner, locks, db, leaseMs };
    }
    if (policy === "skip") {
      return {
        acquired: false,
        owner,
        locks: [],
        busy: result.busy,
        db,
        leaseMs,
      };
    }
    if (!reportedBusy) {
      console.log(`[shard-writer] waiting scopes=${result.busy.join(",")}`);
      reportedBusy = true;
    }
    if (now() >= deadline) {
      throw new Error(
        `[shard-writer] timed out waiting for scopes=${result.busy.join(",")}`,
      );
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}

export async function renewShardWriterLeases(
  leaseSet,
  { now = Date.now } = {},
) {
  const { db, locks, owner, leaseMs } = leaseSet;
  if (!locks?.length) return;
  const refs = locks.map((lock) =>
    db.collection(COLLECTION).doc(docId(normalizeScope(lock))),
  );
  const renewed = await db.runTransaction(async (tx) => {
    const snapshots = [];
    for (const ref of refs) snapshots.push(await tx.get(ref));
    const currentTime = now();
    const valid = snapshots.every((snapshot, index) => {
      const lease = asLease(snapshot);
      return (
        lease &&
        lease.owner === owner &&
        lease.leaseId === locks[index].leaseId &&
        lease.expiresAtMs > currentTime
      );
    });
    if (!valid) return false;
    for (let index = 0; index < refs.length; index++) {
      tx.update(refs[index], { expiresAtMs: currentTime + leaseMs });
    }
    return true;
  });
  if (!renewed)
    throw new Error("[shard-writer] lease ownership was lost before renewal");
}

export async function releaseShardWriterLeases(leaseSet) {
  const { db, locks, owner } = leaseSet;
  if (!locks?.length) return;
  const refs = locks.map((lock) =>
    db.collection(COLLECTION).doc(docId(normalizeScope(lock))),
  );
  const released = await db.runTransaction(async (tx) => {
    const snapshots = [];
    for (const ref of refs) snapshots.push(await tx.get(ref));
    const valid = snapshots.every((snapshot, index) => {
      const lease = asLease(snapshot);
      return (
        lease && lease.owner === owner && lease.leaseId === locks[index].leaseId
      );
    });
    if (!valid) return false;
    for (const ref of refs) tx.delete(ref);
    return true;
  });
  if (!released)
    throw new Error("[shard-writer] lease ownership was lost before release");
  console.log(
    `[shard-writer] released scopes=${locks.map((lock) => lock.key).join(",")}`,
  );
}

export const SHARD_WRITER_LOCK_DEFAULTS = Object.freeze({
  leaseMs: LEASE_MS,
  heartbeatMs: HEARTBEAT_MS,
  pollMs: POLL_MS,
});
