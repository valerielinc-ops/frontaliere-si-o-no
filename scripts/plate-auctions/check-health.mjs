#!/usr/bin/env node
/**
 * Fail-closed CI gate for the plate-auction source matrix and static snapshot.
 * It is intentionally independent from the visual site build: a bad upstream
 * response must stop the data commit before it can produce a stale sitemap.
 *
 * Every error still fails the run. What changed is WHICH errors are allowed to
 * stop the commit, because conflating the two built a loop that could not exit:
 * one unreachable source made the run red, red skipped the commit, and the
 * skipped commit left `previous` frozen at the last good snapshot. The next run
 * then measured a live catalogue against an ever-older baseline, so its natural
 * turnover kept breaking `recognizeCatalogueSales`, which degraded MORE sources
 * every run. Measured on 2026-09-19 (run 35421847071): the committed snapshot
 * was still `generatedAt: 2026-09-15T06:58:44.350Z` after four days, and `lu`
 * was reported `source_disappeared` while the fetch had just returned 133 rows
 * against a baseline of 125 — the source was healthy, the baseline was not.
 *
 * So the two classes are separated at the source:
 *  - `fatal`: the snapshot itself is unusable or self-inconsistent. Publishing
 *    it could serve wrong data, so it must NOT be committed.
 *  - `unhealthy`: one source is degraded. That is a measurement about that
 *    source, and it must not freeze the baseline of the other twenty-five.
 *    The run still goes red; the fresh rows still land.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import registry from "../../data/plate-auction-sources-registry.json" with { type: "json" };
import { FETCHERS } from "./ingest.mjs";

const outputPath = resolve(
  process.env.PLATE_AUCTION_OUTPUT || "public/data/plate-auctions.json",
);
const forbiddenStatuses = new Set(["unverified", "not-discovered", "degraded"]);
const errors = [];
const blockingErrors = [];

/** Structural: the snapshot must not be published in this state. */
const fatal = (message) => {
  errors.push(message);
  blockingErrors.push(message);
};
/** Per-source health: fails the run without freezing everyone else's baseline. */
const unhealthy = (message) => {
  errors.push(message);
};

if (Object.keys(registry.sources).length !== 26) {
  fatal(
    `registry must cover 26 cantons, found ${Object.keys(registry.sources).length}`,
  );
}

for (const [key, source] of Object.entries(registry.sources)) {
  // A forbidden status in the REGISTRY is a committed config mistake, not an
  // observation about today's upstream: nobody decided what this source is.
  if (forbiddenStatuses.has(source.status))
    fatal(`${key}: unresolved registry status ${source.status}`);
  if (source.status === "active" && typeof FETCHERS[key] !== "function")
    fatal(`${key}: active source has no CI fetcher`);
}
for (const key of Object.keys(FETCHERS)) {
  if (registry.sources[key]?.status !== "active")
    fatal(`${key}: CI fetcher is not backed by an active registry source`);
}

if (!existsSync(outputPath)) {
  fatal(`snapshot does not exist: ${outputPath}`);
} else {
  let snapshot;
  let parsed = false;
  try {
    snapshot = JSON.parse(readFileSync(outputPath, "utf8"));
    parsed = true;
  } catch (error) {
    fatal(
      `snapshot is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // A literal `null` — and `0`, `false`, `""`, `[]` — parses fine and is FALSY,
  // so the earlier `if (snapshot)` skipped every structural check below and
  // reported a CLEAN gate on an unusable file. Now that publication reads
  // `blocking`, that silence would also read as permission to commit. Same
  // family as `Number(null) === 0`: `null` is not "empty", it is "not known",
  // so any non-object is rejected here instead of being quietly exempt.
  if (parsed && (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot))) {
    fatal("snapshot must be a JSON object");
  } else if (parsed) {
    if (snapshot.complete !== true)
      fatal("snapshot is not explicitly marked complete");
    const auctions = Array.isArray(snapshot.auctions) ? snapshot.auctions : [];
    const sourceKeys = Object.keys(snapshot.sources || {}).sort();
    const expectedKeys = Object.keys(registry.sources).sort();
    if (JSON.stringify(sourceKeys) !== JSON.stringify(expectedKeys))
      fatal("snapshot source matrix does not match the 26-canton registry");

    for (const [key, source] of Object.entries(registry.sources)) {
      const actual = snapshot.sources?.[key];
      const sourceRows = auctions.filter((row) => String(row.sourceKey || row.platePrefix || '').toLowerCase() === key);
      const actualRowCount = sourceRows.length;
      if (!actual) {
        fatal(`${key}: snapshot source entry is missing`);
        continue;
      }
      // A status mismatch in this direction (registry `active`, snapshot
      // `degraded`) is the fetch result for one source. The dangerous
      // direction — rows published for a source the registry does not call
      // active — is caught structurally below and by the row checks.
      if (actual.status !== source.status)
        unhealthy(`${key}: snapshot status ${actual.status} does not match registry status ${source.status}`);
      if (forbiddenStatuses.has(actual.status))
        unhealthy(`${key}: snapshot status ${actual.status}`);
      if (typeof actual.rowCount !== "number" || actual.rowCount !== actualRowCount)
        fatal(`${key}: rowCount ${actual.rowCount} does not match ${actualRowCount} snapshot rows`);
      if (source.status === "active") {
        if (actual.status !== "active")
          unhealthy(
            `${key}: active source was not fetched successfully (${actual.status})`,
          );
        if (
          typeof actual.lastFetchedAt !== "string" ||
          typeof actual.lastSuccessAt !== "string"
        )
          unhealthy(`${key}: missing successful fetch timestamps`);
        // FATAL, never a health note. Publishing zero rows for a source the
        // registry still calls `active` IS deleting its live listings — the
        // same damage as reclassifying a working catalogue, reached through
        // another door. `ingest.mjs` carries the previous rows forward on a
        // zero or failed fetch precisely so this cannot happen, so an active
        // source at zero rows means that carry-over did NOT happen and the
        // snapshot must not be published. This is not the coupling this file
        // loosens: the five sources that froze the baseline on 2026-09-19 all
        // had carried rows and non-zero counts, so keeping it blocking costs
        // the baseline fix nothing.
        if (actualRowCount < 1)
          fatal(`${key}: active source returned no rows`);
      } else if (actualRowCount > 0) {
        fatal(`${key}: non-active source has ${actualRowCount} snapshot rows`);
      }
      if (typeof actual.lastCheckedAt !== "string")
        fatal(`${key}: missing lastCheckedAt`);
    }

    const expectedCounts = {
      active: auctions.filter((row) => row.auctionStatus === "active").length,
      upcoming: auctions.filter((row) => row.auctionStatus === "upcoming")
        .length,
      closed: auctions.filter((row) =>
        ["closed", "sold", "unsold"].includes(row.auctionStatus),
      ).length,
    };
    for (const [key, value] of Object.entries(expectedCounts)) {
      if (snapshot.counts?.[key] !== value)
        fatal(
          `counts.${key} is stale: expected ${value}, got ${snapshot.counts?.[key]}`,
        );
    }
    const unexpectedAuctionSources = [
      ...new Set(
        auctions.map((row) => String(row.sourceKey || "").toLowerCase()),
      ),
    ].filter((key) => registry.sources[key]?.status !== "active");
    if (unexpectedAuctionSources.length > 0)
      fatal(
        `snapshot contains rows from non-active sources: ${unexpectedAuctionSources.join(", ")}`,
      );
  }
}

const blocking = blockingErrors.length > 0;
const summary = {
  outputPath,
  cantons: Object.keys(registry.sources).length,
  activeConnectors: Object.keys(FETCHERS),
  blocking,
  blockingErrors,
  errors,
};
console.log(JSON.stringify(summary, null, 2));
// The workflow reads this to decide whether the snapshot may be committed. It
// is written before the exit code is set so a red run still publishes the
// verdict, and the workflow requires a literal `false` — a missing output (this
// script crashed) must not read as permission to commit.
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `blocking=${blocking}\nhealth_failed=${errors.length > 0}\n`,
  );
}
// `--blocking-only` exits non-zero for the structural errors alone. It exists
// for the push-retry regenerate command, which rebuilds the snapshot after
// losing a race and must refuse to publish a broken one — but must not abort
// the push just because a source is degraded, since that is the very state the
// commit is now allowed to carry. `health_failed` still carries the complete
// source-health verdict to the workflow step that runs after the retry.
const blockingOnly = process.argv.includes("--blocking-only");
if (blockingOnly ? blocking : errors.length > 0) process.exitCode = 1;
