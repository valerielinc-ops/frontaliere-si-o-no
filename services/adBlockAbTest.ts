/**
 * AdBlock gate A/B bucketing (#3654, part 1/2 of #2961).
 *
 * Stable per-visitor 30/70 split, independent of PostHog: the target
 * population for this experiment is ad-blocking users, so bucket assignment
 * must not depend on a third-party script (PostHog itself can be blocked)
 * succeeding. A persisted anonymous id + deterministic hash gives a bucket
 * that:
 *   - never changes across pageviews/sessions for the same browser
 *     (persisted in localStorage, not recomputed each pageview),
 *   - needs no network round-trip to resolve,
 *   - is reproducible for QA (same id → same bucket, always).
 *
 * The resolved bucket is still reported to PostHog (via registerSuperProperty
 * + an explicit assignment event) so the experiment can be analyzed there —
 * PostHog is the analysis destination, not the source of truth for the split.
 */

import { isLikelyBot } from './botPatterns';
import { isStorageAvailable } from '@/services/storageAvailability';

export type AdBlockAbBucket = 'test' | 'control';

const STORAGE_KEY = 'ft_adblock_anon_id';
const TEST_BUCKET_SHARE = 0.30;

function randomId(): string {
 try {
 if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
 return crypto.randomUUID();
 }
 } catch {
 /* fall through to Math.random-based id */
 }
 return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Deterministic djb2 string hash → non-negative 32-bit-safe integer.
 * Not cryptographic — only needs a stable, well-distributed bucket split.
 */
function djb2Hash(input: string): number {
 let hash = 5381;
 for (let i = 0; i < input.length; i++) {
 hash = (hash * 33) ^ input.charCodeAt(i);
 }
 return hash >>> 0;
}

function getOrCreateAnonId(): string | null {
 if (!isStorageAvailable('__ft_ab_test__')) return null;
 try {
 const existing = localStorage.getItem(STORAGE_KEY);
 if (existing) return existing;
 const fresh = randomId();
 localStorage.setItem(STORAGE_KEY, fresh);
 return fresh;
 } catch {
 return null;
 }
}

/**
 * Resolve the caller's stable A/B bucket. Bots and sessions without
 * localStorage always resolve to `control` (no experiment exposure) — bots
 * because they must never see behavior-altering gates, storage-less
 * sessions because a bucket that can't persist would get reassigned every
 * pageview, defeating the "stable per user" requirement.
 */
export function resolveAdBlockAbBucket(): AdBlockAbBucket {
 if (typeof window === 'undefined') return 'control';
 if (isLikelyBot()) return 'control';
 const anonId = getOrCreateAnonId();
 if (!anonId) return 'control';
 const bucketValue = djb2Hash(anonId) % 100;
 return bucketValue < TEST_BUCKET_SHARE * 100 ? 'test' : 'control';
}
