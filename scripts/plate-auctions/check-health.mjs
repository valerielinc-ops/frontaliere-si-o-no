#!/usr/bin/env node
/**
 * Fail-closed CI gate for the plate-auction source matrix and static snapshot.
 * It is intentionally independent from the visual site build: a bad upstream
 * response must stop the data commit before it can produce a stale sitemap.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import registry from "../../data/plate-auction-sources-registry.json" with { type: "json" };
import { FETCHERS } from "./ingest.mjs";

const outputPath = resolve(
  process.env.PLATE_AUCTION_OUTPUT || "public/data/plate-auctions.json",
);
const forbiddenStatuses = new Set(["unverified", "not-discovered", "degraded"]);
const errors = [];

if (Object.keys(registry.sources).length !== 26) {
  errors.push(
    `registry must cover 26 cantons, found ${Object.keys(registry.sources).length}`,
  );
}

for (const [key, source] of Object.entries(registry.sources)) {
  if (forbiddenStatuses.has(source.status))
    errors.push(`${key}: unresolved registry status ${source.status}`);
  if (source.status === "active" && typeof FETCHERS[key] !== "function")
    errors.push(`${key}: active source has no CI fetcher`);
}
for (const key of Object.keys(FETCHERS)) {
  if (registry.sources[key]?.status !== "active")
    errors.push(
      `${key}: CI fetcher is not backed by an active registry source`,
    );
}

if (!existsSync(outputPath)) {
  errors.push(`snapshot does not exist: ${outputPath}`);
} else {
  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(outputPath, "utf8"));
  } catch (error) {
    errors.push(
      `snapshot is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (snapshot) {
    const sourceKeys = Object.keys(snapshot.sources || {}).sort();
    const expectedKeys = Object.keys(registry.sources).sort();
    if (JSON.stringify(sourceKeys) !== JSON.stringify(expectedKeys))
      errors.push(
        "snapshot source matrix does not match the 26-canton registry",
      );

    for (const [key, source] of Object.entries(registry.sources)) {
      const actual = snapshot.sources?.[key];
      if (!actual) continue;
      if (forbiddenStatuses.has(actual.status))
        errors.push(`${key}: snapshot status ${actual.status}`);
      if (source.status === "active") {
        if (actual.status !== "active")
          errors.push(
            `${key}: active source was not fetched successfully (${actual.status})`,
          );
        if (
          typeof actual.lastFetchedAt !== "string" ||
          typeof actual.lastSuccessAt !== "string"
        )
          errors.push(`${key}: missing successful fetch timestamps`);
        if (typeof actual.rowCount !== "number" || actual.rowCount < 1)
          errors.push(`${key}: active source returned no rows`);
      }
      if (typeof actual.lastCheckedAt !== "string")
        errors.push(`${key}: missing lastCheckedAt`);
    }

    const auctions = Array.isArray(snapshot.auctions) ? snapshot.auctions : [];
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
        errors.push(
          `counts.${key} is stale: expected ${value}, got ${snapshot.counts?.[key]}`,
        );
    }
    const unexpectedAuctionSources = [
      ...new Set(
        auctions.map((row) => String(row.sourceKey || "").toLowerCase()),
      ),
    ].filter((key) => registry.sources[key]?.status !== "active");
    if (unexpectedAuctionSources.length > 0)
      errors.push(
        `snapshot contains rows from non-active sources: ${unexpectedAuctionSources.join(", ")}`,
      );
  }
}

const summary = {
  outputPath,
  cantons: Object.keys(registry.sources).length,
  activeConnectors: Object.keys(FETCHERS),
  errors,
};
console.log(JSON.stringify(summary, null, 2));
if (errors.length > 0) process.exitCode = 1;
