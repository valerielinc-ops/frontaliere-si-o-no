#!/usr/bin/env node
/**
 * Dedicated NVIDIA (ufficio Zurich) crawler runner.
 *
 * Uses the standard crawler template with the NVIDIA (ufficio Zurich) parser.
 * All fetch/parse logic lives in ./lib/nvidia-zurich-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllNvidiaZurichJobs,
  isNvidiaZurichJob,
  isTrustedDomain,
  NVIDIA_ZURICH_KEY,
  NVIDIA_ZURICH_COMPANY_NAME,
} from './lib/nvidia-zurich-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: NVIDIA_ZURICH_KEY,
  companyLabel: NVIDIA_ZURICH_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllNvidiaZurichJobs,
  isCompanyJob: isNvidiaZurichJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ NVIDIA (ufficio Zurich) crawler failed: ${err?.message || err}`);
  process.exit(1);
});
