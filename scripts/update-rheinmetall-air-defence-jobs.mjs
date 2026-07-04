#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRheinmetallAirDefenceJobs,
  isRheinmetallAirDefenceJob,
  isTrustedDomain,
  RHEINMETALL_AIR_DEFENCE_KEY,
  RHEINMETALL_AIR_DEFENCE_COMPANY_NAME,
} from './lib/rheinmetall-air-defence-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: RHEINMETALL_AIR_DEFENCE_KEY,
  companyLabel: RHEINMETALL_AIR_DEFENCE_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRheinmetallAirDefenceJobs,
  isCompanyJob: isRheinmetallAirDefenceJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Rheinmetall Air Defence crawler failed: ${err?.message || err}`);
  process.exit(1);
});
