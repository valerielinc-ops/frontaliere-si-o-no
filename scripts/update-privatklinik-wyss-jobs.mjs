#!/usr/bin/env node
/**
 * Dedicated Privatklinik Wyss crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPrivatklinikWyssJobs,
  isPrivatklinikWyssJob,
  isTrustedDomain,
  PRIVATKLINIK_WYSS_KEY,
  PRIVATKLINIK_WYSS_COMPANY_NAME,
} from './lib/privatklinik-wyss-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: PRIVATKLINIK_WYSS_KEY,
  companyLabel: PRIVATKLINIK_WYSS_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllPrivatklinikWyssJobs,
  isCompanyJob: isPrivatklinikWyssJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Privatklinik Wyss crawler failed: ${err?.message || err}`);
  process.exit(1);
});
