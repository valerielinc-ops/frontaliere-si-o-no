#!/usr/bin/env node
/**
 * Dedicated Carrosserie HESS AG crawler runner.
 *
 * Uses the standard crawler template with the HESS parser.
 * All fetch/parse logic lives in ./lib/hess-carrosserie-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllHessCarrosserieJobs,
  isHessCarrosserieJob,
  isTrustedDomain,
  HESS_CARROSSERIE_KEY,
  HESS_CARROSSERIE_COMPANY_NAME,
  HESS_CARROSSERIE_FABRICATED_DESCRIPTION_RE,
} from './lib/hess-carrosserie-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: HESS_CARROSSERIE_KEY,
  companyLabel: HESS_CARROSSERIE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllHessCarrosserieJobs,
  isCompanyJob: isHessCarrosserieJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
  // Stored jobs still carry the "<title> bei Carrosserie HESS AG …" line and company sentence the parser used to
  // publish instead of a missing body (issue 5253); the merge would keep it,
  // so drop it (and the translations made from it) first.
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(jobs, HESS_CARROSSERIE_FABRICATED_DESCRIPTION_RE, HESS_CARROSSERIE_COMPANY_NAME),
}).catch((err) => {
  console.error(`❌ Carrosserie HESS AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
