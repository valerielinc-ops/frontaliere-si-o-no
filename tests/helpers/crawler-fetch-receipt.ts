export type CrawlerFetchReceipt = {
  specKey: string | null;
  seedUrls: string[];
  phase: 'listing' | 'detail';
  pages: number;
  httpStatuses: Array<{ status: number; url?: string; proxiedBy?: string }>;
  listingTerminalStatus: number | null;
  listingCompletion: string | null;
  proxiedBy: string[];
  fetchOutcome: string | null;
  fetchDetail: string | null;
};

type ReceiptCarrier = { fetchReceipt: CrawlerFetchReceipt };
type ErrorWithSpecFetchReceipt = Error & { specFetchReceipt: CrawlerFetchReceipt };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHttpStatus(value: unknown): value is CrawlerFetchReceipt['httpStatuses'][number] {
  if (!isRecord(value)) return false;
  return typeof value.status === 'number'
    && (value.url === undefined || typeof value.url === 'string')
    && (value.proxiedBy === undefined || typeof value.proxiedBy === 'string');
}

function isCrawlerFetchReceipt(value: unknown): value is CrawlerFetchReceipt {
  if (!isRecord(value)) return false;
  return (typeof value.specKey === 'string' || value.specKey === null)
    && Array.isArray(value.seedUrls)
    && value.seedUrls.every((url: unknown) => typeof url === 'string')
    && (value.phase === 'listing' || value.phase === 'detail')
    && typeof value.pages === 'number'
    && Array.isArray(value.httpStatuses)
    && value.httpStatuses.every(isHttpStatus)
    && (typeof value.listingTerminalStatus === 'number' || value.listingTerminalStatus === null)
    && (typeof value.listingCompletion === 'string' || value.listingCompletion === null)
    && Array.isArray(value.proxiedBy)
    && value.proxiedBy.every((name: unknown) => typeof name === 'string')
    && (typeof value.fetchOutcome === 'string' || value.fetchOutcome === null)
    && (typeof value.fetchDetail === 'string' || value.fetchDetail === null);
}

export function rowsWithFetchReceipt(rows: unknown): unknown[] & ReceiptCarrier {
  if (!Array.isArray(rows) || !('fetchReceipt' in rows) || !isCrawlerFetchReceipt(rows.fetchReceipt)) {
    throw new Error('Crawler rows must include a complete fetch receipt');
  }
  return rows as unknown[] & ReceiptCarrier;
}

export function errorWithSpecFetchReceipt(error: unknown): ErrorWithSpecFetchReceipt {
  if (!(error instanceof Error) || !('specFetchReceipt' in error)) {
    throw new Error('Crawler failure must include its fetch receipt');
  }
  if (!isCrawlerFetchReceipt(error.specFetchReceipt)) {
    throw new Error('Crawler failure must include a complete fetch receipt');
  }
  return error as ErrorWithSpecFetchReceipt;
}
