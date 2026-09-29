#!/usr/bin/env node
/**
 * Dedicated Stadler Rail crawler runner.
 *
 * Uses the standard crawler template with the Stadler Rail parser.
 * All fetch/parse logic lives in ./lib/stadler-rail-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllStadlerRailJobs,
  isStadlerRailJob,
  isTrustedDomain,
  STADLER_RAIL_KEY,
  STADLER_RAIL_COMPANY_NAME,
  STADLER_RAIL_FABRICATED_DESCRIPTION_RE,
} from './lib/stadler-rail-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: STADLER_RAIL_KEY,
  companyLabel: STADLER_RAIL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllStadlerRailJobs,
  isCompanyJob: isStadlerRailJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
  // Stored jobs still carry the paragraph the parser used to publish instead
  // of a short body (issue 5253); the merge would keep it, so drop it first.
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(jobs, STADLER_RAIL_FABRICATED_DESCRIPTION_RE, STADLER_RAIL_COMPANY_NAME),
}).catch((err) => {
  console.error(`❌ Stadler Rail crawler failed: ${err?.message || err}`);
  process.exit(1);
});
