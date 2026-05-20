// scripts/lib/schemas/orphanCluster.mjs
import { z } from 'zod';

const SlugSchema = z.string().min(1).regex(/^[a-z0-9-]+$/);

const OrphanQuerySchema = z.object({
  query: z.string().min(1),
  impressions: z.number().int().nonnegative(),
  clicks: z.number().int().nonnegative(),
});

export const OrphanClusterSchema = z.object({
  clusterId: z.string().min(1),
  locale: z.string().min(1),
  canonicalQuery: z.string().min(1),
  canonicalSlug: SlugSchema,
  roleTokens: z.array(z.string().min(1)).min(1),
  regionTokens: z.array(z.string().min(1)),
  totalImpressions: z.number().int().nonnegative(),
  totalClicks: z.number().int().nonnegative(),
  queries: z.array(OrphanQuerySchema).min(1),
}).passthrough();
