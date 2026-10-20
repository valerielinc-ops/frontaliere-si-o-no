#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllLeTeamJobs,
  isLeTeamJob,
  isTrustedDomain,
  LE_TEAM_KEY,
  LE_TEAM_COMPANY_NAME,
} from './lib/le-team-job-parser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

runStandardCrawlerPipeline({
  companyKey: LE_TEAM_KEY,
  companyLabel: LE_TEAM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllLeTeamJobs,
  isCompanyJob: isLeTeamJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ le team sa crawler failed: ${err?.message || err}`);
  process.exit(1);
});
