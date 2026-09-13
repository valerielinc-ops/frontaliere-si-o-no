/**
 * Runtime-neutral plate-auction quality policy.
 *
 * This file is deliberately plain ESM JavaScript because it runs from both
 * the deployed Functions bundle and the site's node-based ingest command.
 * The TypeScript wrapper adds the site's public types without creating a
 * second implementation of the policy.
 */

const ACTIVE_STATUSES = new Set(['upcoming', 'active']);
const NUMERIC_FIELDS = [
  'currentBidChf',
  'startingPriceChf',
  'finalPriceChf',
  'bidCount',
  'minimumIncrementChf',
];
const DATE_FIELDS = [
  'sourceFetchedAt',
  'lastVerifiedAt',
  'startsAt',
  'endsAt',
  'closedAt',
  'firstSeenAt',
  'lastSeenAt',
  'finalPriceVerifiedAt',
];
const CONFLICTING_CODES = new Set([
  'incoherent-price',
  'source-changed',
  'invalid-date',
  'invalid-date-order',
  'zero-row-anomaly',
]);

function issue(id, code, message) {
  return { id, code, message };
}

function checkNonNumericFields(auction) {
  const issues = [];
  for (const field of NUMERIC_FIELDS) {
    const value = auction[field];
    if (value !== undefined && !Number.isFinite(value)) {
      issues.push(issue(auction.id, 'non-numeric-field', `${auction.id}: field "${field}" is not a finite number (${String(value)})`));
    }
  }
  return issues;
}

function checkIncoherentPrice(auction) {
  const issues = [];
  const { currentBidChf, finalPriceChf, minimumIncrementChf, startingPriceChf, id } = auction;
  if (typeof currentBidChf === 'number' && currentBidChf < 0) {
    issues.push(issue(id, 'incoherent-price', `${id}: currentBidChf is negative (${currentBidChf})`));
  }
  if (typeof finalPriceChf === 'number' && finalPriceChf < 0) {
    issues.push(issue(id, 'incoherent-price', `${id}: finalPriceChf is negative (${finalPriceChf})`));
  }
  if (typeof minimumIncrementChf === 'number' && minimumIncrementChf < 0) {
    issues.push(issue(id, 'incoherent-price', `${id}: minimumIncrementChf is negative (${minimumIncrementChf})`));
  }
  if (typeof startingPriceChf === 'number' && startingPriceChf < 0) {
    issues.push(issue(id, 'incoherent-price', `${id}: startingPriceChf is negative (${startingPriceChf})`));
  }
  if (typeof startingPriceChf === 'number' && typeof currentBidChf === 'number' && currentBidChf < startingPriceChf) {
    issues.push(issue(id, 'incoherent-price', `${id}: currentBidChf (${currentBidChf}) is lower than startingPriceChf (${startingPriceChf})`));
  }
  if (typeof currentBidChf === 'number' && typeof finalPriceChf === 'number' && finalPriceChf < currentBidChf) {
    issues.push(issue(id, 'incoherent-price', `${id}: finalPriceChf (${finalPriceChf}) is lower than currentBidChf (${currentBidChf})`));
  }
  return issues;
}

function checkDateFields(auction) {
  const issues = [];
  const timestamps = new Map();
  for (const field of DATE_FIELDS) {
    const value = auction[field];
    if (value === undefined) continue;
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      issues.push(issue(auction.id, 'invalid-date', `${auction.id}: ${field} is not a parseable date (${value})`));
    } else {
      timestamps.set(field, parsed);
    }
  }
  const startsAt = timestamps.get('startsAt');
  const endsAt = timestamps.get('endsAt');
  if (startsAt !== undefined && endsAt !== undefined && startsAt >= endsAt) {
    issues.push(issue(auction.id, 'invalid-date-order', `${auction.id}: startsAt must be before endsAt`));
  }
  const closedAt = timestamps.get('closedAt');
  if (closedAt !== undefined && endsAt !== undefined && closedAt < endsAt) {
    issues.push(issue(auction.id, 'invalid-date-order', `${auction.id}: closedAt must not precede endsAt`));
  }
  return issues;
}

function checkStaleFetch(auction, now, maxAgeMs = 36 * 60 * 60 * 1000) {
  if (!ACTIVE_STATUSES.has(auction.auctionStatus)) return [];
  const fetchedAt = Date.parse(auction.sourceFetchedAt);
  if (Number.isNaN(fetchedAt) || now.getTime() - fetchedAt <= maxAgeMs) return [];
  return [issue(auction.id, 'stale-fetch', `${auction.id}: sourceFetchedAt is older than ${Math.round(maxAgeMs / 3600000)}h`)];
}

function checkMissingFinal(auction) {
  if (!['closed', 'sold', 'unsold'].includes(auction.auctionStatus)) return [];
  if (typeof auction.finalPriceChf === 'number' && auction.finalPriceVerifiedAt) return [];
  return [issue(auction.id, 'missing-final', `${auction.id}: ${auction.auctionStatus} record has no verified final price`)];
}

function checkDeadlinePassed(auction, now) {
  if (!auction.endsAt || !ACTIVE_STATUSES.has(auction.auctionStatus)) return [];
  const endsAt = new Date(auction.endsAt);
  if (Number.isNaN(endsAt.getTime()) || endsAt.getTime() >= now.getTime()) return [];
  return [issue(auction.id, 'deadline-passed', `${auction.id}: endsAt (${auction.endsAt}) is in the past but auctionStatus is still "${auction.auctionStatus}"`)];
}

function checkDuplicatePlates(auctions) {
  const byPlate = new Map();
  for (const auction of auctions) {
    if (!ACTIVE_STATUSES.has(auction.auctionStatus)) continue;
    const key = `${auction.canton}:${auction.normalizedPlate}`;
    const group = byPlate.get(key) || [];
    group.push(auction);
    byPlate.set(key, group);
  }
  const issues = [];
  for (const group of byPlate.values()) {
    if (group.length < 2) continue;
    const ids = group.map((auction) => auction.id).sort();
    for (const auction of group) {
      issues.push(issue(auction.id, 'duplicate-plate', `${auction.id}: plate "${auction.normalizedPlate}" (${auction.canton}) has ${group.length} active records: ${ids.join(', ')}`));
    }
  }
  return issues;
}

function checkSourceChanged(auction, previous) {
  if (!previous || previous.rawSnapshotHash === auction.rawSnapshotHash) return [];
  const identityChanged = previous.canton !== auction.canton
    || previous.normalizedPlate !== auction.normalizedPlate
    || previous.officialAuctionUrl !== auction.officialAuctionUrl;
  if (!identityChanged) return [];
  return [issue(auction.id, 'source-changed', `${auction.id}: source identity changed between fetches (was ${previous.canton}/${previous.normalizedPlate}/${previous.officialAuctionUrl}, now ${auction.canton}/${auction.normalizedPlate}/${auction.officialAuctionUrl})`)];
}

function checkDisappearedSources(auctions, previousById) {
  const currentIds = new Set(auctions.map((auction) => auction.id));
  return [...previousById.values()]
    .filter((previous) => ACTIVE_STATUSES.has(previous.auctionStatus) && !currentIds.has(previous.id))
    .map((previous) => issue(previous.id, 'source-disappeared', `${previous.id}: active source record disappeared from the next fetch`));
}

export function checkPlateAuctionQuality(auctions, previousById, now = new Date()) {
  const issues = [...checkDuplicatePlates(auctions)];
  if (auctions.length === 0 && previousById && previousById.size > 0) {
    issues.push(issue('batch', 'zero-row-anomaly', `fetch returned zero rows after a previous batch contained ${previousById.size} records`));
  }
  for (const auction of auctions) {
    issues.push(...checkNonNumericFields(auction));
    issues.push(...checkIncoherentPrice(auction));
    issues.push(...checkDeadlinePassed(auction, now));
    issues.push(...checkDateFields(auction));
    issues.push(...checkStaleFetch(auction, now));
    issues.push(...checkMissingFinal(auction));
    if (previousById) issues.push(...checkSourceChanged(auction, previousById.get(auction.id)));
  }
  if (previousById) issues.push(...checkDisappearedSources(auctions, previousById));
  return issues;
}

export function derivePlateAuctionDataConfidence(current, issuesForId) {
  if (!issuesForId || issuesForId.length === 0) return current;
  if (issuesForId.some((item) => CONFLICTING_CODES.has(item.code))) return 'conflicting';
  return 'partial';
}
