#!/usr/bin/env node
/**
 * Dedicated Gesundheitszentrum Fricktal (GZF) crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllGesundheitszentrumFricktalJobs,
  isGesundheitszentrumFricktalJob,
  isTrustedDomain,
  GZF_KEY,
  GZF_COMPANY_NAME,
} from './lib/gesundheitszentrum-fricktal-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: GZF_KEY,
  companyLabel: GZF_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllGesundheitszentrumFricktalJobs,
  isCompanyJob: isGesundheitszentrumFricktalJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Gesundheitszentrum Fricktal crawler failed: ${err?.message || err}`);
  process.exit(1);
});
