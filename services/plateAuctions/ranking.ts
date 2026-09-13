import type { PlateAuction } from './types';

export type PlateAuctionRankingMode = 'current' | 'final';
export type PlateAuctionRankingPeriod = 'week' | 'month' | 'year' | 'all-time';

export interface DateWindow {
  start: string;
  end: string;
}

export interface PlateAuctionRankingRow {
  rank: number;
  auction: PlateAuction;
  amountChf: number;
}

function zonedParts(date: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]),
  );
}

function dateKey(parts: Record<string, number>): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function shiftDateKey(key: string, days: number): string {
  const [year, month, day] = key.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function zonedMidnight(dateKeyValue: string, timeZone: string): Date {
  const [year, month, day] = dateKeyValue.split('-').map(Number);
  const utcGuess = Date.UTC(year, month - 1, day);
  const local = zonedParts(new Date(utcGuess), timeZone);
  const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return new Date(utcGuess - (localAsUtc - utcGuess));
}

function isoWeekday(dateKeyValue: string): number {
  const [year, month, day] = dateKeyValue.split('-').map(Number);
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return dayOfWeek === 0 ? 7 : dayOfWeek;
}

export function getRankingWindow(
  period: PlateAuctionRankingPeriod,
  now = new Date(),
  timeZone = 'Europe/Zurich',
): DateWindow | null {
  if (period === 'all-time') return null;
  const today = dateKey(zonedParts(now, timeZone));
  let start = today;
  if (period === 'week') start = shiftDateKey(today, 1 - isoWeekday(today));
  if (period === 'month') start = `${today.slice(0, 7)}-01`;
  if (period === 'year') start = `${today.slice(0, 4)}-01-01`;
  const end = period === 'week'
    ? shiftDateKey(start, 7)
    : period === 'month'
      ? shiftDateKey(`${today.slice(0, 7)}-01`, 32).slice(0, 8) + '01'
      : `${Number(today.slice(0, 4)) + 1}-01-01`;
  return {
    start: zonedMidnight(start, timeZone).toISOString(),
    end: zonedMidnight(end, timeZone).toISOString(),
  };
}

function isFinalVerified(auction: PlateAuction): boolean {
  return ['closed', 'sold', 'unsold'].includes(auction.auctionStatus)
    && typeof auction.finalPriceChf === 'number'
    && auction.dataConfidence === 'verified'
    && typeof auction.finalPriceVerifiedAt === 'string';
}

function dateForAuction(auction: PlateAuction): number | null {
  const value = auction.closedAt || auction.endsAt || auction.finalPriceVerifiedAt;
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function currentAmount(auction: PlateAuction): number | undefined {
  // A direct-sale catalogue may expose only its fixed amount. It is still a
  // current public price, but never a final auction result.
  return auction.currentBidChf ?? (auction.listingType === 'fixed-price' ? auction.startingPriceChf : undefined);
}

function latestRecordById(auctions: readonly PlateAuction[]): PlateAuction[] {
  const latest = new Map<string, PlateAuction>();
  for (const auction of auctions) {
    const previous = latest.get(auction.id);
    if (!previous) {
      latest.set(auction.id, auction);
      continue;
    }
    const previousTime = Date.parse(previous.finalPriceVerifiedAt || previous.sourceFetchedAt);
    const nextTime = Date.parse(auction.finalPriceVerifiedAt || auction.sourceFetchedAt);
    if (!Number.isFinite(previousTime) || nextTime >= previousTime) latest.set(auction.id, auction);
  }
  return [...latest.values()];
}

export function rankPlateAuctions(
  auctions: readonly PlateAuction[],
  {
    mode = 'current',
    period = 'all-time',
    canton,
    now = new Date(),
    limit = 100,
  }: {
    mode?: PlateAuctionRankingMode;
    period?: PlateAuctionRankingPeriod;
    canton?: string;
    now?: Date;
    limit?: number;
  } = {},
): PlateAuctionRankingRow[] {
  const window = getRankingWindow(period, now);
  const start = window ? Date.parse(window.start) : Number.NEGATIVE_INFINITY;
  const end = window ? Date.parse(window.end) : Number.POSITIVE_INFINITY;
  const candidates = auctions.filter((auction) => {
    if (canton && auction.sourceKey !== canton && auction.platePrefix !== canton) return false;
    if (mode === 'final') {
      if (!isFinalVerified(auction)) return false;
    } else if (!['active', 'upcoming'].includes(auction.auctionStatus)
      || auction.dataConfidence === 'conflicting'
      || currentAmount(auction) === undefined) {
      return false;
    }
    if (!window) return true;
    const time = dateForAuction(auction);
    return time !== null && time >= start && time < end;
  });
  const amount = (auction: PlateAuction): number => mode === 'final' ? auction.finalPriceChf! : currentAmount(auction)!;
  const uniqueCandidates = mode === 'final' ? latestRecordById(candidates) : candidates;
  return uniqueCandidates
    .sort((left, right) => amount(right) - amount(left) || (right.bidCount || 0) - (left.bidCount || 0) || left.id.localeCompare(right.id))
    .slice(0, Math.max(0, limit))
    .map((auction, index) => ({ rank: index + 1, auction, amountChf: amount(auction) }));
}

export function countVerifiedFinals(auctions: readonly PlateAuction[]): number {
  return auctions.filter(isFinalVerified).length;
}

export function isPlateAuctionFinalVerified(auction: PlateAuction): boolean {
  return isFinalVerified(auction);
}
