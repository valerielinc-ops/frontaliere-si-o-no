#!/usr/bin/env node
/**
 * Dedicated SonarSource (Sonar) crawler runner.
 *
 * Uses the standard crawler template with the SonarSource (Sonar) parser.
 * All fetch/parse logic lives in ./lib/sonarsource-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllSonarsourceJobs,
  isSonarsourceJob,
  isTrustedDomain,
  SONARSOURCE_KEY,
  SONARSOURCE_COMPANY_NAME,
} from './lib/sonarsource-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: SONARSOURCE_KEY,
  companyLabel: SONARSOURCE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllSonarsourceJobs,
  isCompanyJob: isSonarsourceJob,
  isTrustedDomain,
  defaultSourceLang: 'en',
}).catch((err) => {
  console.error(`❌ SonarSource (Sonar) crawler failed: ${err?.message || err}`);
  process.exit(1);
});
