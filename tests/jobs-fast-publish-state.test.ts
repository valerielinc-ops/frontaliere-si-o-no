import { describe, expect, it } from "vitest";
import {
  discoverFastPublishJobs,
  fastPublishJobFingerprint,
  markFastPublishJobsPublished,
} from "../scripts/lib/jobs-fast-publish-state.mjs";

class FakeSnapshot {
  constructor(id, value) {
    this.id = id;
    this.exists = value !== undefined;
    this.value = value;
  }

  data() {
    return structuredClone(this.value);
  }
}

class FakeTransaction {
  constructor(db) {
    this.db = db;
  }

  async get(ref) {
    return new FakeSnapshot(ref.id, this.db.documents.get(ref.id));
  }

  set(ref, value) {
    this.db.documents.set(ref.id, structuredClone(value));
  }

  update(ref, value) {
    this.db.documents.set(ref.id, {
      ...(this.db.documents.get(ref.id) || {}),
      ...structuredClone(value),
    });
  }

  delete(ref) {
    this.db.documents.delete(ref.id);
  }
}

class FakeFirestore {
  documents = new Map();

  collection() {
    return {
      doc: (id) => ({
        id,
        get: async () => new FakeSnapshot(id, this.documents.get(id)),
      }),
    };
  }

  async runTransaction(callback) {
    return callback(new FakeTransaction(this));
  }
}

const now = Date.UTC(2026, 10, 11, 12);

function job(id, daysAgo, overrides = {}) {
  return {
    stableId: id,
    slug: id,
    title: `Titolo ${id}`,
    company: "Esempio SA",
    firstSeenAt: new Date(now - daysAgo * 86_400_000).toISOString(),
    ...overrides,
  };
}

describe("jobs-fast durable state", () => {
  it("reads without writes and bootstraps only recent unseen offers", async () => {
    const db = new FakeFirestore();
    const crawledAt = "2026-11-11T11:30:00.000Z";
    const offers = [job("recent", 1, { crawledAt }), job("old-backlog", 10)];
    const pathsForJob = (offer) => [
      `/cerca-lavoro-ticino/${offer.slug}/`,
      `/en/find-jobs-ticino/${offer.slug}/`,
      `/de/jobs-im-tessin/${offer.slug}/`,
      `/fr/trouver-emploi-tessin/${offer.slug}/`,
    ];

    const preview = await discoverFastPublishJobs(offers, {
      db,
      now,
      write: false,
      pathsForJob,
    });
    expect(preview.map((row) => row.id)).toEqual(["recent"]);
    expect(db.documents.size).toBe(0);

    const queued = await discoverFastPublishJobs(offers, {
      db,
      now,
      write: true,
      pathsForJob,
    });
    expect(queued.map((row) => row.id)).toEqual(["recent"]);
    expect(queued[0].previousPaths).toEqual([]);
    expect(queued[0].crawlAtMs).toBe(Date.parse(crawledAt));
    expect(db.documents.size).toBeGreaterThan(0);
  });

  it("stores pre-cutoff canonical paths so a later slug change can remove the old sitemap URLs", async () => {
    const db = new FakeFirestore();
    const original = job("offer-old", 10, { slug: "old-route" });
    const oldPaths = [
      "/cerca-lavoro-ticino/old-route/",
      "/en/find-jobs-ticino/old-route/",
      "/de/jobs-im-tessin/old-route/",
      "/fr/trouver-emploi-tessin/old-route/",
    ];

    const bootstrapped = await discoverFastPublishJobs([original], {
      db,
      now,
      write: true,
      pathsForJob: () => oldPaths,
    });
    expect(bootstrapped).toEqual([]);

    const changed = { ...original, slug: "new-route" };
    const pending = await discoverFastPublishJobs([changed], {
      db,
      now,
      write: true,
      pathsForJob: () => [
        "/cerca-lavoro-ticino/new-route/",
        "/en/find-jobs-ticino/new-route/",
        "/de/jobs-im-tessin/new-route/",
        "/fr/trouver-emploi-tessin/new-route/",
      ],
    });

    expect(pending).toHaveLength(1);
    expect(pending[0].previousPaths).toEqual([...oldPaths].sort());
  });

  it("fails closed when a live bootstrap cannot record canonical paths", async () => {
    await expect(
      discoverFastPublishJobs([job("old-backlog", 10)], {
        db: new FakeFirestore(),
        now,
        write: true,
      }),
    ).rejects.toThrow("pathsForJob is required");
  });

  it("bootstraps a fully shadowed offer with no previous routes to remove", async () => {
    const db = new FakeFirestore();
    const original = job("shadowed-old-offer", 10);

    await expect(
      discoverFastPublishJobs([original], {
        db,
        now,
        write: true,
        pathsForJob: () => [],
      }),
    ).resolves.toEqual([]);

    const changed = { ...original, title: "Titolo aggiornato" };
    const pending = await discoverFastPublishJobs([changed], {
      db,
      now,
      write: true,
      pathsForJob: () => [],
    });
    expect(pending).toHaveLength(1);
    expect(pending[0].previousPaths).toEqual([]);
  });

  it("deduplicates published fingerprints and carries prior canonical paths for changed offers", async () => {
    const db = new FakeFirestore();
    const original = job("offer-1", 1);
    const first = await discoverFastPublishJobs([original], {
      db,
      now,
      write: true,
    });
    await markFastPublishJobsPublished(
      [
        {
          id: first[0].id,
          hash: first[0].hash,
          paths: [
            "/cerca-lavoro-ticino/offer-1/",
            "/en/jobs-in-tessin/offer-1/",
          ],
        },
      ],
      { db },
    );

    expect(
      await discoverFastPublishJobs([original], { db, now, write: true }),
    ).toEqual([]);

    const changed = { ...original, title: "Titolo aggiornato" };
    const pending = await discoverFastPublishJobs([changed], {
      db,
      now,
      write: true,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0].previousPaths).toEqual([
      "/cerca-lavoro-ticino/offer-1/",
      "/en/jobs-in-tessin/offer-1/",
    ]);
    await markFastPublishJobsPublished(
      [
        {
          id: pending[0].id,
          hash: pending[0].hash,
          paths: pending[0].previousPaths,
        },
      ],
      { db },
    );
    expect(
      await discoverFastPublishJobs([changed], { db, now, write: false }),
    ).toEqual([]);
  });

  it("ignores volatile crawler timestamps without hiding content changes", () => {
    const base = job("same", 1, {
      crawledAt: "2026-11-10T08:00:00.000Z",
      nested: { lastCheckedAt: "a", value: 2 },
    });
    const heartbeat = {
      ...base,
      crawledAt: "2026-11-11T08:00:00.000Z",
      nested: { lastCheckedAt: "b", value: 2 },
    };
    expect(fastPublishJobFingerprint(base)).toBe(
      fastPublishJobFingerprint(heartbeat),
    );
    expect(fastPublishJobFingerprint(base)).not.toBe(
      fastPublishJobFingerprint({
        ...base,
        nested: { ...base.nested, value: 3 },
      }),
    );
  });
});
