#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPlanzerJobs,
  isPlanzerJob,
  isTrustedDomain,
  PLANZER_KEY,
  PLANZER_COMPANY_NAME,
  PLANZER_FABRICATED_DESCRIPTION_RE,
  stripPlanzerFabricatedDescription,
} from './lib/planzer-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PLANZER_KEY,
  companyLabel: PLANZER_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPlanzerJobs,
  isCompanyJob: isPlanzerJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(
    jobs,
    PLANZER_FABRICATED_DESCRIPTION_RE,
    PLANZER_COMPANY_NAME,
    { strip: stripPlanzerFabricatedDescription },
  ),
}).catch((err) => {
  console.error(`❌ Planzer crawler failed: ${err?.message || err}`);
  process.exit(1);
});
