// scripts/lib/schemas/borderWait.mjs
//
// Schema for border-wait data written by scripts/snapshot-border-wait-history.mjs
// and produced by functions/src/trafficSchedulerCore.js.
//
// Real shape confirmed from data/border-wait-current.json (22 crossings, 2026-05-20).
import { z } from 'zod';

/**
 * A single per-crossing entry as written to data/border-wait-current.json
 * (one entry per crossing slug in the `perCrossing` map).
 *
 * Fields from trafficSchedulerCore.js (line ~298):
 *   waitTimeMinutes  — integer 0–720
 *   approachMinutes  — may be null when not computed
 *   totalCrossingMinutes — may be null
 *   status           — 'green' | 'yellow' | 'red'
 *   source           — traffic provider used for this measurement
 *   lastUpdate       — ISO 8601 datetime string
 */
export const BorderWaitCurrentEntrySchema = z.object({
  waitTimeMinutes: z.number().int().min(0).max(720),
  approachMinutes: z.number().int().min(0).nullable(),
  totalCrossingMinutes: z.number().int().min(0).nullable(),
  status: z.enum(['green', 'yellow', 'red']),
  source: z.enum(['here', 'tomtom', 'google-maps']),
  lastUpdate: z.string().datetime(),
}).passthrough();

/**
 * The top-level structure of data/border-wait-current.json.
 */
export const BorderWaitCurrentFileSchema = z.object({
  updatedAt: z.string().datetime().nullable(),
  perCrossing: z.record(z.string().min(1), BorderWaitCurrentEntrySchema),
});

/**
 * A single hour-bucket in the daily history aggregate.
 * null means no samples were collected for that hour.
 */
const BorderWaitHourBucketSchema = z
  .object({
    min: z.number().int().min(0),
    avg: z.number().int().min(0),
    max: z.number().int().min(0),
    samples: z.number().int().min(1),
  })
  .nullable();

/**
 * The top-level structure of data/border-wait-history/YYYY-MM-DD.json.
 * Each crossing maps to an array of exactly 24 hour-buckets (0–23 UTC).
 */
export const BorderWaitHistoryFileSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date-not-YYYY-MM-DD'),
  perCrossing: z.record(
    z.string().min(1),
    z.array(BorderWaitHourBucketSchema).length(24),
  ),
});
