#!/usr/bin/env node
/**
 * Dedicated yellowshark AG crawler runner.
 *
 * Uses the standard crawler template with the yellowshark AG parser.
 * All fetch/parse logic lives in ./lib/yellowshark-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllYellowsharkJobs,
  isYellowsharkJob,
  isTrustedDomain,
  YELLOWSHARK_KEY,
  YELLOWSHARK_COMPANY_NAME,
} from './lib/yellowshark-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: YELLOWSHARK_KEY,
  companyLabel: YELLOWSHARK_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllYellowsharkJobs,
  isCompanyJob: isYellowsharkJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ yellowshark AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
