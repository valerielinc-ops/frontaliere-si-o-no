#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  deillonDelleyArchitectesMatchKey,
  fetchAllDeillonDelleyArchitectesJobs,
  isDeillonDelleyArchitectesJob,
  isTrustedDomain,
  DEILLON_DELLEY_ARCHITECTES_COMPANY_NAME,
  DEILLON_DELLEY_ARCHITECTES_KEY,
} from './lib/deillon-delley-architectes-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: DEILLON_DELLEY_ARCHITECTES_KEY,
  companyLabel: DEILLON_DELLEY_ARCHITECTES_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllDeillonDelleyArchitectesJobs,
  isCompanyJob: isDeillonDelleyArchitectesJob,
  isTrustedDomain,
  matchKey: deillonDelleyArchitectesMatchKey,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Deillon Delley Architectes crawler failed: ${err?.message || err}`);
  process.exit(1);
});
