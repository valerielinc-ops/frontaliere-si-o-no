#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllModellstationSomosaJobs,
  isModellstationSomosaJob,
  isTrustedDomain,
  MODELLSTATION_SOMOSA_KEY,
  MODELLSTATION_SOMOSA_COMPANY_NAME,
} from './lib/modellstation-somosa-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: MODELLSTATION_SOMOSA_KEY,
  companyLabel: MODELLSTATION_SOMOSA_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllModellstationSomosaJobs,
  isCompanyJob: isModellstationSomosaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Modellstation SOMOSA crawler failed: ${err?.message || err}`);
  process.exit(1);
});
