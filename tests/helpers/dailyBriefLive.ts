import { ARTICLES_API_BASE } from '../../scripts/lib/articles-api-base.mjs';

export type DailyBriefPublicationState = 'published' | 'not-published' | 'unknown';

const SLUGS_JSON_TIMEOUT_MS = 8_000;
const publicationStateCache = new Map<string, Promise<DailyBriefPublicationState>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The publisher's canonical id, independent of the locale-specific URL slug. */
export function dailyBriefEditionId(date: string): string {
  return `bollettino-frontaliere-${date}`;
}

/**
 * Classify only an exact, structurally valid publisher entry.
 *
 * A malformed or partial registry is unknown on purpose: a live check may
 * skip an unavailable page only when the publisher explicitly says that exact
 * edition has not been emitted yet.
 */
export function classifyDailyBriefPublication(
  payload: unknown,
  editionId: string,
): DailyBriefPublicationState {
  if (!isRecord(payload) || !isRecord(payload.blog)) return 'unknown';
  if (!Object.prototype.hasOwnProperty.call(payload.blog, editionId)) return 'not-published';

  const slugMap = payload.blog[editionId];
  if (!isRecord(slugMap)) return 'unknown';
  if (!Object.values(slugMap).some((slug) => typeof slug === 'string' && slug.trim())) return 'unknown';
  return 'published';
}

async function readDailyBriefPublicationState(editionId: string): Promise<DailyBriefPublicationState> {
  if (typeof fetch !== 'function') return 'unknown';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SLUGS_JSON_TIMEOUT_MS);
  try {
    const response = await fetch(`${ARTICLES_API_BASE.replace(/\/+$/, '')}/slugs.json`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return 'unknown';
    return classifyDailyBriefPublication(await response.json(), editionId);
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Read the registry once per edition per Playwright worker. Unknown remains a
 * hard failure for the caller; it is never treated as an unpublished edition.
 */
export function dailyBriefPublicationState(editionId: string): Promise<DailyBriefPublicationState> {
  const cached = publicationStateCache.get(editionId);
  if (cached) return cached;
  const state = readDailyBriefPublicationState(editionId);
  publicationStateCache.set(editionId, state);
  return state;
}

/** A non-200 is skippable only when the publisher confirms no such edition. */
export function shouldSkipUnpublishedDailyBrief(
  status: number | undefined,
  publicationState: DailyBriefPublicationState,
): boolean {
  return status !== undefined && status !== 200 && publicationState === 'not-published';
}
