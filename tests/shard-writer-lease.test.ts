import { describe, expect, it } from "vitest";
import {
  acquireShardWriterLeases,
  releaseShardWriterLeases,
  renewShardWriterLeases,
} from "../scripts/lib/shard-writer-lease.mjs";

class Snapshot {
  constructor(id, value) {
    this.id = id;
    this.exists = value !== undefined;
    this.value = value;
  }

  data() {
    return structuredClone(this.value);
  }
}

class Transaction {
  constructor(db) {
    this.db = db;
  }
  async get(ref) {
    return new Snapshot(ref.id, this.db.documents.get(ref.id));
  }
  set(ref, value) {
    this.db.documents.set(ref.id, structuredClone(value));
  }
  update(ref, patch) {
    this.db.documents.set(ref.id, {
      ...this.db.documents.get(ref.id),
      ...structuredClone(patch),
    });
  }
  delete(ref) {
    this.db.documents.delete(ref.id);
  }
}

class FakeFirestore {
  documents = new Map();
  collection() {
    return { doc: (id) => ({ id }) };
  }
  async runTransaction(callback) {
    return callback(new Transaction(this));
  }
}

describe("shared shard writer lease", () => {
  it("lets one writer own a section/locale and makes the fast lane skip a busy scope", async () => {
    const db = new FakeFirestore();
    const scope = { section: "ticino", locale: "it" };
    const first = await acquireShardWriterLeases([scope], {
      db,
      owner: "full-deploy",
      now: () => 100_000,
    });

    const skipped = await acquireShardWriterLeases([scope], {
      db,
      owner: "jobs-fast",
      policy: "skip",
      now: () => 100_001,
    });
    expect(skipped.acquired).toBe(false);
    expect(skipped.busy).toEqual(["ticino:it"]);

    await renewShardWriterLeases(first, { now: () => 110_000 });
    await releaseShardWriterLeases(first);
    const afterRelease = await acquireShardWriterLeases([scope], {
      db,
      owner: "jobs-fast",
      now: () => 120_000,
    });
    expect(afterRelease.acquired).toBe(true);
    await releaseShardWriterLeases(afterRelease);
  });

  it("acquires multiple scopes in normalized, deduplicated order", async () => {
    const db = new FakeFirestore();
    const leases = await acquireShardWriterLeases(
      [
        { section: "zurigo", locale: "en" },
        { section: "ticino", locale: "it" },
        { section: "zurigo", locale: "en" },
      ],
      { db, owner: "jobs-fast", now: () => 1_000 },
    );
    expect(leases.locks.map((lock) => lock.key)).toEqual([
      "ticino:it",
      "zurigo:en",
    ]);
    await releaseShardWriterLeases(leases);
  });
});
